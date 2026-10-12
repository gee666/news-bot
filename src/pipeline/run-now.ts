import { z } from 'zod';
import { db, transaction } from '../db.js';
import { withManualUsage } from '../models/usage-scope.js';
import { getSettings, settingsSchema } from '../settings.js';
import { publishRunNow } from '../publishing/run-now.js';
import { locked } from '../publishing/store.js';
import { processBatch } from './batches.js';
import { withLease } from './lease.js';
import { collectRunNow, useCollectedInputs } from './run-now-collection.js';
import { automaticFailureHeld } from './failure-admission.js';
import { Waiting } from './state.js';
import type { RunNowProgress } from './run-now-contract.js';

export interface RunNowJob { id: string; createdAt: string; batchId?: string | undefined; runNow?: RunNowProgress | undefined }
export interface RunNowOutcome {
  status: 'waiting' | 'succeeded' | 'completed_with_errors' | 'failed'; message: string; nextRetryAt?: string | null;
}
const batchSchema = z.object({ id: z.uuid(), cutoff_at: z.date(), settings_snapshot: settingsSchema,
  status: z.string(), next_retry_at: z.date().nullable(), error_code: z.string().nullable() });
const scopeSchema = z.object({ storyIds: z.array(z.uuid()).default([]), omittedStories: z.number().default(0) });
class SavedManualBatchMissing extends Error {}
const waiting = (message: string, next = new Date(Date.now() + 2000)): RunNowOutcome =>
  ({ status: 'waiting', message, nextRetryAt: next.toISOString() });

async function batchFor(job: RunNowJob, progress: RunNowProgress) {
  const settings = await getSettings();
  return transaction(async client => {
    const previous = await client.query(`SELECT b.* FROM processing_batches b JOIN operational_state o
      ON o.key='run_now_batch:'||b.id::text WHERE o.value->>'runId'=$1`, [job.id]);
    if (previous.rows[0]) return batchSchema.parse(previous.rows[0]);
    if (job.batchId) throw new SavedManualBatchMissing('Saved manual batch is no longer available');
    const result = await client.query(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,manual_operation_id)
      VALUES('collecting',now(),$1,$2,$3,$4) RETURNING *`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion, job.id]);
    const batch = batchSchema.parse(result.rows[0]);
    await client.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
      [`run_now_batch:${batch.id}`, JSON.stringify({ runId: job.id, storyLimit: progress.options.storyLimit })]);
    return batch;
  });
}

async function counts(batchId: string, progress: RunNowProgress): Promise<void> {
  const inputs = await db.query<{ total: number; completed: number; rejected: number; failed: number }>(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status='rejected')::int AS rejected,
    count(*) FILTER(WHERE status='failed')::int AS failed FROM batch_items WHERE batch_id=$1`, [batchId]);
  const row = inputs.rows[0];
  progress.inputs = row?.total ?? 0; progress.processed = row?.completed ?? 0;
  progress.rejected = row?.rejected ?? 0; progress.failed = row?.failed ?? 0;
  progress.reasons = {};
  if (progress.rejected) progress.reasons.input_not_news = progress.rejected;
  if (progress.failed) progress.reasons.input_validation_failed = progress.failed;
  const sources = await db.query<{ total: number; failed: number }>(`SELECT count(*)::int AS total,
    count(*) FILTER(WHERE status='failed')::int AS failed FROM batch_sources WHERE batch_id=$1`, [batchId]);
  progress.sources = sources.rows[0]?.total ?? 0;
  if (sources.rows[0]?.failed) progress.reasons.source_collection_failed = sources.rows[0].failed;
}

async function runLocked(job: RunNowJob, checkpoint: () => Promise<void>, signal: AbortSignal): Promise<RunNowOutcome> {
  const progress = job.runNow;
  if (!progress) throw new Error('Manual run options are missing');
  const batch = await batchFor(job, progress);
  job.batchId = batch.id;
  await checkpoint();
  const settings = batch.settings_snapshot;
  if (['queued', 'collecting'].includes(progress.stage)) {
    progress.stage = 'collecting'; await checkpoint();
    if (batch.next_retry_at && batch.next_retry_at > new Date()) return waiting('Collection is waiting for its saved connector cooldown.', batch.next_retry_at);
    if (signal.aborted) return waiting('Server is stopping. Saved work will resume after restart.', new Date(Date.now() + 300000));
    try {
      if (progress.options.mode === 'collect') await collectRunNow(batch.id, batch.cutoff_at, settings, progress.options);
      else await useCollectedInputs(batch.id, settings, progress.options.inputLimit);
    } catch (error) {
      if (!(error instanceof Waiting)) throw error;
      const saved = batchSchema.parse((await db.query('SELECT * FROM processing_batches WHERE id=$1', [batch.id])).rows[0]);
      await counts(batch.id, progress);
      if (saved.error_code) progress.reasons[saved.error_code] = 1;
      return waiting('Collection is waiting for its saved connector cooldown.', saved.next_retry_at ?? undefined);
    }
    progress.stage = 'processing'; await counts(batch.id, progress); await checkpoint();
  }
  if (signal.aborted) return waiting('Server is stopping. No new stage was dispatched.', new Date(Date.now() + 300000));
  // false means automatic admission: a manual click never clears failures or provider waits.
  try {
    await processBatch(false, true, batch.id, async id => {
      if (signal.aborted) return;
      try {
        // Publisher holders never acquire the processor lease. Wait at this committed
        // story boundary rather than skipping ready delivery until the rest of the batch.
        await locked('news-bot-digest', async () => {
          const result = await publishRunNow(settings, job.id, [id], progress.options.publicationLimit, job.createdAt);
          progress.published = result.published; progress.updated = result.updated;
          Object.assign(progress.reasons, result.reasons);
        });
      } catch { progress.reasons.ready_publication_deferred = 1; }
      await checkpoint();
    });
  } catch { /* Read the durable stage/batch outcome below. */ }
  await counts(batch.id, progress);
  const saved = batchSchema.parse((await db.query('SELECT * FROM processing_batches WHERE id=$1', [batch.id])).rows[0]);
  if (saved.status !== 'completed') {
    await checkpoint();
    if (saved.status === 'failed') {
      await db.query('UPDATE processing_batches SET completed_at=coalesce(completed_at,now()) WHERE id=$1', [batch.id]);
      return { status: 'failed', message: `Manual batch failed: ${saved.error_code ?? 'processing_failed'}. Saved inputs remain available for explicit correction.` };
    }
    if (saved.error_code) progress.reasons[saved.error_code] = 1;
    return waiting('Processing saved progress. Provider waits and interrupted-request cooldowns are not bypassed.', saved.next_retry_at ?? undefined);
  }
  const raw = await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [`run_now_batch:${batch.id}`]);
  const scope = scopeSchema.parse(raw.rows[0]?.value);
  progress.stories = scope.storyIds.length;
  if (scope.omittedStories) progress.reasons.story_limit = scope.omittedStories;
  const publishable: string[] = [];
  for (const id of scope.storyIds) {
    const reason = await automaticFailureHeld(id) ? 'automatic_retry_wait_or_exhausted' : null;
    if (reason) progress.reasons[reason] = (progress.reasons[reason] ?? 0) + 1;
    else publishable.push(id);
  }
  const stories = await db.query<{ status: string; interest_score: number | null; count: number }>(`SELECT status,interest_score,count(*)::int AS count
    FROM stories WHERE id=ANY($1::uuid[]) GROUP BY status,interest_score`, [publishable]);
  for (const story of stories.rows) {
    const reason = story.status === 'rejected' ? 'story_not_news' : story.status === 'failed' ? 'story_validation_failed'
      : story.status !== 'completed' ? 'story_not_ready' : (story.interest_score ?? 0) < settings.minimumPublicationScore ? 'below_publication_score' : null;
    if (reason) progress.reasons[reason] = (progress.reasons[reason] ?? 0) + story.count;
  }
  progress.stage = 'publishing'; await checkpoint();
  if (signal.aborted) return waiting('Server is stopping before publication.', new Date(Date.now() + 300000));
  let result: Awaited<ReturnType<typeof publishRunNow>> | undefined;
  const publisherAvailable = await withLease('news-bot-digest', async () => {
    result = await publishRunNow(settings, job.id, publishable, progress.options.publicationLimit, job.createdAt);
  });
  if (!publisherAvailable || !result) return waiting('Publisher busy. Ready stories retain this run\'s saved cap.');
  progress.published = result.published; progress.updated = result.updated;
  Object.assign(progress.reasons, result.reasons);
  await checkpoint();
  if (result.reasons.publishing_disabled && stories.rows.some(story => story.status === 'completed'
    && (story.interest_score ?? 0) >= settings.minimumPublicationScore)) {
    return waiting('Publishing is paused. Ready stories retain this run\'s saved scope and cap.', new Date(Date.now() + 5000));
  }
  if (result.waiting) return waiting('Publication is waiting for Telegram cooldown or delivery reconciliation.', new Date(Date.now() + 300000));
  progress.stage = 'finished';
  const problems = Object.keys(progress.reasons).length > 0;
  return { status: problems ? 'completed_with_errors' : 'succeeded',
    message: `Finished. ${progress.inputs} new revisions, ${progress.stories} selected stories, ${progress.published} new posts, ${progress.updated} existing posts updated. No digest backlog replay.` };
}

export async function runNow(job: RunNowJob, checkpoint: () => Promise<void>, signal: AbortSignal): Promise<RunNowOutcome> {
  let result: RunNowOutcome = waiting('Pipeline busy. Waiting for the active pipeline or publisher lease.');
  // Processing never holds the publication lease through paid stages. Ready callbacks
  // acquire it only after completion commits; publisher holders never need the processor lease.
  await withLease('news-bot-digest-refresh', async () => {
    await withLease('news-bot-pipeline', async () => {
      try { result = await withManualUsage(job.id, () => runLocked(job, checkpoint, signal)); }
      catch (error) {
        if (!(error instanceof SavedManualBatchMissing)) throw error;
        result = { status: 'failed', message: 'Saved manual batch is no longer available. No collection or publication was restarted.' };
      }
    });
  });
  return result;
}
