import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import type { StoryWorkReport } from './story-failures.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';
import { retryDecision } from './state.js';

export async function saveOperational(key: string, value: unknown): Promise<void> {
  await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key)
    DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key, JSON.stringify(value)]);
}
export type OperationalReport = StoryWorkReport;
export class OperationalDeferred extends Error {
  constructor(message: string, readonly retryMs = 15_000) { super(message); }
}
const stateSchema = z.object({ attempt: z.number().int().nonnegative().default(0), next: z.string().nullable().default(null),
  phase: z.enum(['running','waiting','failed','completed']).optional() });

export async function operationalWork(key: string, settings: AppSettings, _manual: boolean,
  run: (attempt: number) => Promise<void | OperationalReport>): Promise<boolean> {
  const parsed = stateSchema.safeParse((await db.query<{ value: unknown }>(
    'SELECT value FROM operational_state WHERE key=$1', [key])).rows[0]?.value);
  const state = parsed.success ? parsed.data : { attempt: 0, next: null };
  if (state.next && Date.parse(state.next)>Date.now()) return false;
  const attempt = state.attempt+1;
  await saveOperational(key, { attempt: state.attempt, phase: 'running', next: null });
  try {
    const report = await run(attempt);
    await saveOperational(key, { attempt: 0, phase: 'completed', next: null,
      completedAt: new Date().toISOString(), ...report });
    return true;
  } catch (error) {
    if (error instanceof OperationalDeferred) {
      await saveOperational(key, { attempt: state.attempt, phase: 'waiting', next: new Date(Date.now()+error.retryMs).toISOString(),
        code: 'lease_busy', reason: error.message });
      return false;
    }
    await recordProcessingDiagnostic(error, { scope: 'operation', operation: key });
    const decision = retryDecision(error, attempt, settings);
    // Infrastructure retries never require a healthy-provider probe or operator approval.
    // Story failures already have their own bounded budgets.
    await saveOperational(key, { attempt, phase: 'waiting', next: decision.next ?? new Date(Date.now()+settings.retryMaxMs),
      code: decision.code, reason: decision.reason });
    throw error;
  }
}
