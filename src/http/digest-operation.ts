import { z } from 'zod';
import { db } from '../db.js';
import type { Operation, OperationOutcome } from './operations.js';

const timestamp = z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.iso.datetime());
const reportSchema = z.object({
  phase: z.enum(['completed', 'waiting', 'running', 'failed']),
  failedStories: z.number().int().nonnegative().optional(), completedStories: z.number().int().nonnegative().optional(),
  next: z.iso.datetime().nullable().optional(), completedAt: z.iso.datetime().optional(),
  retryEpoch: z.number().int().nonnegative().default(0), totalAttempts: z.number().int().nonnegative().default(0),
});
const stateSchema = z.object({ value: reportSchema, updated_at: timestamp, newer_manual: z.boolean().default(false) });
type DigestState = z.infer<typeof stateSchema>;

async function readState(operation: Operation): Promise<DigestState | undefined> {
  const result = await db.query<{ value: unknown; updated_at: unknown; newer_manual: unknown }>(`SELECT d.value,d.updated_at,
    EXISTS(SELECT 1 FROM operational_state w WHERE w.key LIKE 'web_operation:%'
      AND w.value->>'kind'='digest' AND w.key<>$1
      AND (w.value->>'createdAt')::timestamptz>$2::timestamptz
      AND (w.value->>'createdAt')::timestamptz<=d.updated_at) AS newer_manual
    FROM operational_state d WHERE d.key='pipeline_digest'`, [`web_operation:${operation.id}`, operation.createdAt]);
  const parsed = stateSchema.safeParse(result.rows[0]);
  return parsed.success ? parsed.data : undefined;
}

function outcome(state: DigestState): OperationOutcome {
  const report = state.value;
  if (report.phase === 'failed') return { status: 'failed', nextRetryAt: null,
    message: 'Digest refresh failed. Correct the pipeline failure before starting a new manual refresh.' };
  if (report.phase !== 'completed') return { status: 'waiting', nextRetryAt: report.next ?? null,
    message: 'Digest refresh is waiting. The pipeline owns recovery at the saved retry time.' };
  if (report.failedStories) return { status: 'completed_with_errors',
    message: `Digest refreshed ${report.completedStories ?? 0} stories; ${report.failedStories} withheld after validation failures.` };
  return { status: 'succeeded', message: 'Digest refresh completed.' };
}

function settledAttempts(state: DigestState): number {
  // Running includes the current attempt; lease deferral later removes it from the durable total.
  return state.value.phase === 'running' ? Math.max(0, state.value.totalAttempts - 1) : state.value.totalAttempts;
}

function bind(operation: Operation, state: DigestState): void {
  operation.digestRun = { retryEpoch: state.value.retryEpoch, totalAttempts: settledAttempts(state),
    updatedAt: state.updated_at };
}

export async function observeDigest(operation: Operation): Promise<OperationOutcome | undefined> {
  if (operation.kind !== 'digest' || !['running', 'waiting'].includes(operation.status)) return;
  const state = await readState(operation);
  if (!state || state.newer_manual) return;
  const binding = operation.digestRun;
  if (Date.parse(state.updated_at) < Date.parse(binding?.updatedAt ?? operation.createdAt)) return;
  // A retry advances once from a saved wait. A different epoch or skipped counters belongs to another run.
  if (binding && (state.value.retryEpoch !== binding.retryEpoch ||
      settledAttempts(state) < binding.totalAttempts || settledAttempts(state) > binding.totalAttempts + 1)) return;
  const result = outcome(state);
  bind(operation, state);
  return result;
}

export async function runDigestOperation(operation: Operation, run: () => Promise<void>): Promise<OperationOutcome> {
  await run();
  const state = await readState(operation);
  if (!state || state.newer_manual) return { status: 'waiting', message: 'Digest refresh is waiting for the pipeline lease.' };
  if (['completed', 'failed'].includes(state.value.phase) && Date.parse(state.updated_at) < Date.parse(operation.createdAt)) {
    return { status: 'waiting', message: 'Digest refresh was skipped while another operation held the lease.' };
  }
  bind(operation, state);
  return outcome(state);
}
