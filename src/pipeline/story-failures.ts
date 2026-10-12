import { z } from 'zod';
import { failureInputBoundary, failureBoundaryFingerprint } from './failure-admission.js';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { prepareUpdates } from '../publishing/updates.js';
import { hash, retryDecision, Waiting } from './state.js';
import { ProcessingYield } from './processing-slice.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';

export interface StoryWorkReport { completedStories: number; failedStories: number; skippedStories: number }
const key = (id: string) => `pipeline_failed_story:${id}`;
const markerSchema = z.object({ storyId: z.uuid(), fingerprint: z.string(), attempts: z.number().int().nonnegative(),
  next: z.string().nullable(), errorCode: z.string() });

export async function storyFailureFingerprint(id: string, settings: AppSettings): Promise<string> {
  return hash({ input: failureBoundaryFingerprint(await failureInputBoundary(id)),
    profile: settings.profileVersion, model: settings.modelVersion });
}

async function clearStoryFailure(storyId: string): Promise<void> {
  await db.query('DELETE FROM operational_state WHERE key=$1', [key(z.uuid().parse(storyId))]);
  await db.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${storyId}`]);
}

/** One failed story cannot abort the rest of the batch or digest. */
export async function storyWork(id: string, settings: AppSettings, batchId: string | null,
  run: () => Promise<boolean>): Promise<'completed' | 'failed' | 'skipped' | 'rejected'> {
  const fingerprint = await storyFailureFingerprint(id, settings);
  const parsed = markerSchema.safeParse((await db.query<{ value: unknown }>(
    'SELECT value FROM operational_state WHERE key=$1', [key(id)])).rows[0]?.value);
  const previous = parsed.success && parsed.data.fingerprint === fingerprint ? parsed.data : undefined;
  if (previous && (!previous.next || Date.parse(previous.next)>Date.now())) return 'skipped';
  try {
    const completed = await run();
    await clearStoryFailure(id);
    return completed ? 'completed' : 'rejected';
  } catch (error) {
    if (error instanceof ProcessingYield) throw error;
    if (error instanceof Waiting) return 'skipped';
    await recordProcessingDiagnostic(error, { scope: 'story', storyId: id, batchId });
    const attempts = (previous?.attempts ?? 0)+1;
    const decision = retryDecision(error, attempts, settings);
    await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key)
      DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key(id), JSON.stringify({ storyId: id, fingerprint,
        inputBoundary: await failureInputBoundary(id), attempts, next: decision.next?.toISOString() ?? null, errorCode: decision.code })]);
    await db.query("UPDATE stories SET status='failed',updated_at=now() WHERE id=$1", [id]);
    await db.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${id}`]);
    return 'failed';
  }
}

export async function prepareStoryFailureUpdates(settings: AppSettings, storyIds?: string[], cancelOnly = false): Promise<void> {
  const destinations = await db.query<{ destination_id: string }>(`SELECT DISTINCT destination_id FROM publications
    WHERE status='published' AND pending_snapshot_id IS NOT NULL`);
  for (const row of destinations.rows) await prepareUpdates(settings, row.destination_id, storyIds, { cancelOnly });
}

export function countStoryOutcome(report: StoryWorkReport, outcome: Awaited<ReturnType<typeof storyWork>>): void {
  if (outcome === 'completed') report.completedStories++;
  if (outcome === 'failed') report.failedStories++;
  if (outcome === 'skipped') report.skippedStories++;
}
