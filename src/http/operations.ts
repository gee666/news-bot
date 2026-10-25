import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, transaction } from '../db.js';
import { partialCompletionLabel } from './status-labels.js';
import type { ModelFailure } from '../models/index.js';
import { canRetryFailure, failureResponseMetadata } from '../models/errors.js';
import { runNowOptionsSchema, runNowProgressSchema, type RunNowOptions } from '../pipeline/run-now-contract.js';
export const operationKind = z.enum(['test_jev', 'test_embedding', 'test_pi', 'collection', 'digest', 'cleanup', 'refresh_sources', 'run_now']);
export type OperationKind = z.infer<typeof operationKind>;
const operationSchema = z.object({
  id: z.uuid(), kind: operationKind, batchId: z.uuid().optional(), runNow: runNowProgressSchema.optional(),
  digestRun: z.object({ retryEpoch: z.number().int().nonnegative(), totalAttempts: z.number().int().nonnegative(),
    updatedAt: z.iso.datetime() }).strict().optional(),
  status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'completed_with_errors', 'failed']),
  attempt: z.number().int().positive(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  nextRetryAt: z.iso.datetime().nullable(),
  message: z.string(),
  failure: z.object({ kind: z.string(), outcome: z.string(), durationMs: z.number().nonnegative() }).nullable(),
}).strict();
export type Operation = z.infer<typeof operationSchema>;
export interface OperationOutcome {
  status: Operation['status'];
  message: string;
  nextRetryAt?: string | null;
}
export type OperationRunner = (operation: Operation, recordFailure: (failure: ModelFailure) => Promise<void>, signal: AbortSignal, checkpoint: () => Promise<void>) => Promise<void | OperationOutcome>;
type OperationObserver = (operation: Operation) => Promise<OperationOutcome | undefined>;
const key = (id: string) => `web_operation:${id}`;
async function persist(operation: Operation): Promise<void> {
  await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [key(operation.id), JSON.stringify(operation)]);
}

export class Operations {
  private readonly active = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  constructor(private readonly runner: OperationRunner, private readonly observer?: OperationObserver,
    private readonly requestMaxAttempts: () => Promise<number> = async () => 5) {}

  private async observe(operation: Operation): Promise<Operation> {
    if (!this.observer || this.active.has(operation.id) || ['completed_with_errors', 'failed'].includes(operation.status)) return operation;
    if (operation.status === 'succeeded' && (operation.kind !== 'collection' || !operation.batchId)) return operation;
    const previousBinding = JSON.stringify(operation.digestRun);
    const observed = await this.observer(operation);
    if (observed && (operation.status !== observed.status || operation.message !== observed.message ||
        operation.nextRetryAt !== (observed.nextRetryAt ?? null) || previousBinding !== JSON.stringify(operation.digestRun))) {
      operation.status = observed.status;
      operation.message = observed.message;
      operation.nextRetryAt = observed.nextRetryAt ?? null;
      operation.updatedAt = new Date().toISOString();
      await persist(operation);
    }
    return operation;
  }

  async get(id: string): Promise<Operation | null> {
    const result = await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [key(id)]);
    return result.rows[0] ? this.observe(operationSchema.parse(result.rows[0].value)) : null;
  }

  async list(): Promise<Operation[]> {
    const result = await db.query<{ value: unknown }>(`SELECT value FROM operational_state
      WHERE key LIKE 'web_operation:%' ORDER BY updated_at DESC LIMIT 30`);
    return Promise.all(result.rows.map(row => this.observe(operationSchema.parse(row.value))));
  }

  async start(kind: OperationKind, options?: RunNowOptions): Promise<Operation> {
    if (this.controller.signal.aborted) throw new Error('Server is stopping');
    const operation = await transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(736428139)');
      const existing = await client.query<{ value: unknown }>(`SELECT value FROM operational_state
        WHERE key LIKE 'web_operation:%' AND value->>'kind'=$1
          AND value->>'status' IN ('queued','running','waiting') LIMIT 1`, [kind]);
      if (existing.rows[0]) return operationSchema.parse(existing.rows[0].value);
      const now = new Date().toISOString();
      const next: Operation = { id: randomUUID(), kind, status: 'queued', attempt: 1,
        createdAt: now, updatedAt: now, nextRetryAt: null, message: 'Queued.', failure: null,
        ...(kind === 'run_now' ? { runNow: runNowProgressSchema.parse({ options: runNowOptionsSchema.parse(options ?? {}), stage: 'queued' }) } : {}) };
      await client.query('INSERT INTO operational_state(key,value) VALUES($1,$2)', [key(next.id), JSON.stringify(next)]);
      return next;
    });
    this.dispatch(operation);
    return this.observe(operation);
  }

  async resume(): Promise<void> {
    // A submitted test may still be executing remotely. Wait before a new submission after restart.
    const result = await db.query<{ value: unknown }>(`SELECT value FROM operational_state
      WHERE key LIKE 'web_operation:%' AND value->>'status' IN ('queued','running','waiting')`);
    const requestMaxAttempts = await this.requestMaxAttempts();
    for (const row of result.rows) {
      const operation = operationSchema.parse(row.value);
      if (operation.kind === 'run_now') {
        if (operation.status === 'running') {
          operation.status = 'waiting';
          operation.nextRetryAt = new Date(Date.now() + 300000).toISOString();
          operation.message = 'Interrupted by restart. Saved batch and publication IDs will resume after the unknown-request cooldown.';
          operation.updatedAt = new Date().toISOString();
          await persist(operation);
        }
        if (operation.status === 'queued') this.dispatch(operation);
        continue;
      }
      if (this.observer && (operation.batchId || (operation.kind === 'digest' && operation.status !== 'queued'))) {
        await this.observe(operation);
        continue;
      }
      if (operation.status === 'running') {
        operation.status = operation.kind.startsWith('test_') && canRetryFailure('timeout', operation.attempt, requestMaxAttempts)
          ? 'waiting' : 'failed';
        operation.nextRetryAt = operation.status === 'waiting' ? new Date(Date.now() + 300_000).toISOString() : null;
        operation.message = 'Interrupted by restart. Submitted work may have an unknown outcome.';
        operation.failure = { kind: 'restart_unknown', outcome: 'unknown', durationMs: 0 };
        operation.updatedAt = new Date().toISOString();
        await transaction(async client => {
          await client.query(`INSERT INTO request_attempts
            (provider,operation,attempt_number,status,finished_at,next_retry_at,error_code,response_metadata)
            VALUES($1,$2,$3,'unknown',now(),$4,'restart_unknown',$5)`,
          [operation.kind.startsWith('test_') ? operation.kind.slice(5) : 'web', key(operation.id), operation.attempt,
            operation.nextRetryAt, JSON.stringify({ outcome: 'unknown' })]);
          await client.query('UPDATE operational_state SET value=$2,updated_at=now() WHERE key=$1',
            [key(operation.id), JSON.stringify(operation)]);
        });
      }
      if (operation.status === 'queued') this.dispatch(operation);
    }
    this.timer = setInterval(() => { void this.tick().catch(() => { console.error('Operation retry check failed.'); }); }, 2000);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.controller.signal.aborted) return;
    this.ticking = true;
    try {
      const stranded = await db.query<{ value: unknown }>(`SELECT value FROM operational_state
        WHERE key LIKE 'web_operation:%' AND value->>'kind'='run_now' AND value->>'status'='running'`);
      for (const row of stranded.rows) {
        const operation = operationSchema.parse(row.value);
        if (this.active.has(operation.id)) continue;
        operation.status = 'waiting'; operation.nextRetryAt = new Date(Date.now() + 300000).toISOString();
        operation.message = 'Manual run interrupted while saving progress. Retrying its saved batch after cooldown.';
        operation.updatedAt = new Date().toISOString(); await persist(operation);
      }
      const result = await db.query<{ value: unknown }>(`SELECT value FROM operational_state
        WHERE key LIKE 'web_operation:%' AND value->>'status'='waiting'
          AND value->>'kind' IN ('test_jev','test_embedding','test_pi','run_now')
          AND (value->>'nextRetryAt')::timestamptz <= now()`);
      for (const row of result.rows) this.dispatch(operationSchema.parse(row.value));
      if (this.observer) {
        const pipelineOperations = await db.query<{ value: unknown }>(`SELECT value FROM operational_state
          WHERE key LIKE 'web_operation:%' AND value->>'status' IN ('running','waiting')
            AND ((value->>'kind'='collection' AND value ? 'batchId') OR value->>'kind'='digest')`);
        for (const row of pipelineOperations.rows) await this.observe(operationSchema.parse(row.value));
      }
      await db.query(`DELETE FROM request_attempts WHERE operation LIKE 'web_operation:%'
        AND finished_at < now() - interval '14 days'
        AND NOT EXISTS (SELECT 1 FROM operational_state s WHERE s.key=request_attempts.operation
          AND s.value->>'status' IN ('queued','running','waiting'))`);
      await db.query(`DELETE FROM operational_state WHERE key LIKE 'web_operation:%'
        AND value->>'status' IN ('failed','succeeded','completed_with_errors') AND updated_at < now() - interval '14 days'`);
    } finally { this.ticking = false; }
  }

  private dispatch(operation: Operation): void {
    if (this.active.has(operation.id) || ['failed', 'succeeded', 'completed_with_errors'].includes(operation.status) || this.controller.signal.aborted) return;
    if (operation.batchId && !operation.kind.startsWith('test_') && operation.kind !== 'run_now') return;
    if (operation.kind === 'digest' && operation.status !== 'queued') return;
    if (operation.status === 'waiting' && operation.nextRetryAt && Date.parse(operation.nextRetryAt) > Date.now()) return;
    const work = this.execute(operation).catch(() => { console.error('Could not persist operation status.'); })
      .finally(() => { this.active.delete(operation.id); });
    this.active.set(operation.id, work);
  }

  private async execute(operation: Operation): Promise<void> {
    if (operation.status === 'waiting') operation.attempt++;
    operation.status = 'running';
    operation.message = operation.kind.startsWith('test_') ? 'Waiting for the shared model slot or response.' : 'Running.';
    operation.nextRetryAt = null;
    operation.updatedAt = new Date().toISOString();
    await persist(operation);
    let recorded = false;
    const recordFailure = async (failure: ModelFailure) => {
      const retryable = failure.retryable && canRetryFailure(failure.kind, failure.attempt, await this.requestMaxAttempts());
      const nextRetryAt = retryable ? failure.nextRetryAt : null;
      operation.status = retryable ? 'waiting' : 'failed';
      operation.nextRetryAt = nextRetryAt;
      operation.message = failure.message;
      operation.failure = { kind: failure.kind, outcome: failure.outcome, durationMs: failure.durationMs };
      operation.updatedAt = new Date().toISOString();
      await transaction(async client => {
        await client.query(`INSERT INTO request_attempts
          (provider,operation,attempt_number,status,dispatched_at,finished_at,next_retry_at,error_code,response_metadata)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [failure.service, key(operation.id), failure.attempt,
          failure.outcome === 'unknown' ? 'unknown' : retryable ? 'retryable' : 'failed',
          new Date(Date.parse(failure.failedAt) - failure.durationMs), failure.failedAt, nextRetryAt,
          failure.kind, JSON.stringify(failureResponseMetadata(failure))]);
        await client.query('UPDATE operational_state SET value=$2,updated_at=now() WHERE key=$1',
          [key(operation.id), JSON.stringify(operation)]);
      });
      recorded = true;
    };
    try {
      const result = await this.runner(operation, recordFailure, this.controller.signal, async () => {
        operation.updatedAt = new Date().toISOString();
        await persist(operation);
      });
      operation.status = result?.status ?? 'succeeded';
      operation.message = result?.message ?? 'Completed.';
      operation.nextRetryAt = result?.nextRetryAt ?? null;
      operation.failure = null;
    } catch {
      if (!recorded) {
        operation.status = operation.kind === 'run_now' ? 'waiting' : 'failed';
        operation.nextRetryAt = operation.kind === 'run_now' ? new Date(Date.now() + 300000).toISOString() : null;
        operation.message = operation.kind === 'run_now'
          ? 'Manual run interrupted. Saved batch ownership is retained; retrying after cooldown. Check service availability.'
          : 'Operation failed. Check configuration, login and service availability.';
      }
    }
    operation.updatedAt = new Date().toISOString();
    await persist(operation);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await Promise.allSettled(this.active.values());
  }
}

const timestamp = z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.iso.datetime());
const batchSchema = z.object({ id: z.uuid(), status: z.enum(['queued', 'collecting', 'processing', 'waiting', 'completed', 'failed']),
  next_retry_at: timestamp.nullable(), error_code: z.string().nullable(), failed_items: z.number().int().nonnegative() });

function collectionOutcome(batch: z.infer<typeof batchSchema>): OperationOutcome {
  if (batch.status === 'completed' && batch.error_code === 'partial_story_failure') {
    return { status: 'completed_with_errors', message: 'Collection completed with withheld stories. See processing status for counts and correction.' };
  }
  if (batch.status === 'completed' && batch.error_code === 'partial_item_failure') {
    return { status: 'completed_with_errors', message: `${partialCompletionLabel(batch.failed_items)}. Withheld items need explicit correction.` };
  }
  if (batch.status === 'completed') return { status: 'succeeded', message: 'Collection batch completed.' };
  if (batch.status === 'failed') return { status: 'failed', message: 'Collection batch failed. See processing status for the stage and failure reason.' };
  if (batch.status === 'queued') return { status: 'waiting', nextRetryAt: batch.next_retry_at,
    message: 'Collected source snapshot is queued. Model processing is paused or earlier work owns the processor.' };
  if (batch.status === 'waiting') return { status: 'waiting', nextRetryAt: batch.next_retry_at,
    message: 'Collection batch is waiting. The pipeline will resume it at the saved retry time.' };
  return { status: 'running', message: 'Collection batch is still processing. Follow processing status for progress.' };
}

export async function observeCollection(operation: Operation): Promise<OperationOutcome | undefined> {
  if (operation.kind !== 'collection' || !operation.batchId) return;
  const result = await db.query<{ id: unknown; status: unknown; next_retry_at: unknown; error_code: unknown; failed_items: unknown }>(
    `SELECT b.id,b.status,b.next_retry_at,b.error_code,
      (SELECT count(*)::int FROM batch_items i WHERE i.batch_id=b.id AND i.status='failed') AS failed_items
      FROM processing_batches b WHERE b.id=$1`, [operation.batchId]);
  // History cleanup must not turn a previously completed operation into a failure.
  return result.rows[0] ? collectionOutcome(batchSchema.parse(result.rows[0])) : undefined;
}

export async function runCollectionOperation(operation: Operation, run: () => Promise<void>): Promise<OperationOutcome> {
  const existing = await db.query<{ id: string }>(`SELECT id FROM processing_batches
    WHERE completed_at IS NULL AND status IN ('queued','collecting','processing','waiting','failed')
    ORDER BY CASE WHEN status IN ('collecting','processing','waiting') THEN 0 WHEN status='failed' THEN 1 ELSE 2 END,started_at LIMIT 1`);
  const existingId = existing.rows[0] ? z.uuid().parse(existing.rows[0].id) : null;
  let failed = false;
  try { await run(); } catch { failed = true; }
  finally {
    // A failed batch can be replaced when settings changed. Prefer that new batch over its predecessor.
    const result = await db.query<{ id: string }>(`SELECT id FROM processing_batches
      WHERE id=$1 OR started_at >= $2 ORDER BY started_at DESC LIMIT 1`, [existingId, operation.createdAt]);
    if (result.rows[0]) operation.batchId = z.uuid().parse(result.rows[0].id);
  }
  const observed = await observeCollection(operation);
  if (failed && observed?.status !== 'waiting' && observed?.status !== 'failed') {
    return { status: 'failed', message: 'Collection request failed. See processing status for the failure reason.' };
  }
  return observed ?? { status: 'failed',
    message: 'Collection was skipped without creating a batch. The pipeline may be busy with another operation.' };
}

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

function digestOutcome(state: DigestState): OperationOutcome {
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
  const result = digestOutcome(state);
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
  return digestOutcome(state);
}
