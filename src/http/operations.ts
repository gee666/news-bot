import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, transaction } from '../db.js';
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
