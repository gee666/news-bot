import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelFailure } from '../models/index.js';
import { failureMetadata, RequestFault } from '../models/errors.js';
import { observeDigest, runDigestOperation, Operations, type Operation, type OperationRunner } from './operations.js';
const storage = vi.hoisted(() => ({ records: new Map<string, unknown>(), attempts: [] as unknown[][],
  digest: undefined as unknown, digestUpdatedAt: '' }));
vi.mock('../db.js', () => {
  const query = async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes("WHERE d.key='pipeline_digest'")) return { rows: storage.digest ? [
      { value: storage.digest, updated_at: storage.digestUpdatedAt, newer_manual: false },
    ] : [] };
    if (sql.includes('INSERT INTO request_attempts')) { storage.attempts.push(parameters); return { rows: [] }; }
    if (sql.includes('INSERT INTO operational_state') || sql.includes('UPDATE operational_state SET value')) {
      const name = parameters[0];
      const value = parameters[1];
      if (typeof name !== 'string' || typeof value !== 'string') throw new Error('Invalid test record');
      const parsed: unknown = JSON.parse(value);
      storage.records.set(name, parsed);
      return { rows: [] };
    }
    if (sql.includes('SELECT value FROM operational_state WHERE key=$1')) {
      const value = storage.records.get(String(parameters[0]));
      return { rows: value ? [{ value }] : [] };
    }
    if (sql.includes('SELECT value FROM operational_state')) {
      const rows = Array.from(storage.records.values()).filter(value => {
        if (!value || typeof value !== 'object') return false;
        const status = Reflect.get(value, 'status');
        if (sql.includes("value->>'kind'='run_now'") && Reflect.get(value, 'kind') !== 'run_now') return false;
        if (sql.includes("value->>'status'='running'") && status !== 'running') return false;
        if (sql.includes("value->>'kind'=$1") && Reflect.get(value, 'kind') !== parameters[0]) return false;
        if (sql.includes("value->>'kind' IN ('test_jev','test_embedding','test_pi','run_now')") &&
            !['test_jev', 'test_embedding', 'test_pi', 'run_now'].includes(Reflect.get(value, 'kind'))) return false;
        if (sql.includes("IN ('queued','running','waiting')") && !['queued', 'running', 'waiting'].includes(status)) return false;
        if (sql.includes("value->>'status'='waiting'")) {
          const next = Reflect.get(value, 'nextRetryAt');
          return status === 'waiting' && typeof next === 'string' && Date.parse(next) <= Date.now();
        }
        return true;
      }).map(value => ({ value }));
      return { rows };
    }
    return { rows: [] };
  };
  const db = { query };
  return { db, transaction: async (run: (client: typeof db) => Promise<unknown>) => run(db) };
});
let operations: Operations;
beforeEach(() => { storage.records.clear(); storage.attempts = []; storage.digest = undefined; storage.digestUpdatedAt = ''; });
afterEach(async () => { await operations?.stop(); vi.useRealTimers(); });
const failure = (operation: Operation): ModelFailure => ({
  operationId: operation.id, service: 'jev', kind: 'timeout', message: 'The request deadline expired; server-side completion is unknown.',
  attempt: operation.attempt, failedAt: new Date().toISOString(), nextRetryAt: new Date(Date.now() + 300_000).toISOString(),
  retryable: true, outcome: 'unknown', durationMs: 1000,
});
describe('durable asynchronous operations', () => {
  it('persists manual progress checkpoints and ignores duplicate-click limit changes', async () => {
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runner = vi.fn<OperationRunner>(async (operation, _failure, _signal, checkpoint) => {
      if (!operation.runNow) throw new Error('Missing manual progress');
      operation.runNow.stage = 'processing'; operation.runNow.inputs = 2;
      await checkpoint(); await pending;
      return { status: 'succeeded', message: 'Finished two inputs.' };
    });
    operations = new Operations(runner);
    const current = await operations.start('run_now');
    await vi.waitFor(async () => expect((await operations.get(current.id))?.runNow).toMatchObject({ stage: 'processing', inputs: 2 }));
    const duplicate = await operations.start('run_now', { mode: 'collect', publicationLimit: 10, sourceLimit: 10, inputLimit: 50, storyLimit: 10 });
    expect(duplicate.id).toBe(current.id); expect(duplicate.runNow?.options.publicationLimit).toBe(5);
    expect(runner).toHaveBeenCalledOnce(); release();
    await vi.waitFor(async () => expect((await operations.get(current.id))?.status).toBe('succeeded'));
  });
  it('resumes a saved manual batch after restart cooldown without losing its bounded scope', async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const { runNowProgressSchema } = await import('../pipeline/run-now-contract.js');
    const current: Operation = { id: '946b26ea-14f9-473d-8a1f-6bf47b15b62a', kind: 'run_now', status: 'running',
      batchId: '268e2059-7fdd-48db-9525-3b16a5f5a6e6', attempt: 1, createdAt: now, updatedAt: now,
      nextRetryAt: null, message: 'Publishing.', failure: null, runNow: runNowProgressSchema.parse({ options: { publicationLimit: 1 }, stage: 'publishing' }) };
    storage.records.set(`web_operation:${current.id}`, current);
    const runner = vi.fn<OperationRunner>(async operation => {
      expect(operation.batchId).toBe(current.batchId); expect(operation.runNow?.options.publicationLimit).toBe(1);
      return { status: 'succeeded', message: 'Saved selection reconciled.' };
    });
    operations = new Operations(runner);
    await operations.resume(); expect(runner).not.toHaveBeenCalled();
    expect((await operations.get(current.id))?.status).toBe('waiting');
    await vi.advanceTimersByTimeAsync(299000); expect(runner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000); expect(runner).toHaveBeenCalledOnce();
    expect((await operations.get(current.id))?.status).toBe('succeeded');
  });
  it('keeps an interrupted manual run recoverable instead of stranding its active batch', async () => {
    operations = new Operations(async operation => { operation.batchId = operation.id; throw new Error('Private checkpoint failure'); });
    const current = await operations.start('run_now');
    await vi.waitFor(async () => expect((await operations.get(current.id))?.status).toBe('waiting'));
    expect((await operations.start('run_now')).id).toBe(current.id);
    expect((await operations.get(current.id))?.nextRetryAt).not.toBeNull();
    expect((await operations.get(current.id))?.batchId).toBe(current.id);
    expect(JSON.stringify(await operations.get(current.id))).not.toContain('Private');
  });
  it('returns a handle without waiting and reuses an active operation', async () => {
    let release = () => {};
    const pending = new Promise<void>(resolve => { release = resolve; });
    const runner = vi.fn(async () => pending);
    operations = new Operations(runner);
    const first = await operations.start('test_jev');
    const second = await operations.start('test_jev');
    expect(second.id).toBe(first.id);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    expect((await operations.get(first.id))?.status).toBe('running');
    release();
    await vi.waitFor(async () => expect((await operations.get(first.id))?.status).toBe('succeeded'));
  });
  it('commits model failure metadata and does not bypass the retry deadline on another click', async () => {
    const runner = vi.fn<OperationRunner>(async (operation, recordFailure) => {
      await recordFailure(failure(operation));
      throw new Error('provider-secret-never-saved');
    });
    operations = new Operations(runner);
    const first = await operations.start('test_jev');
    await vi.waitFor(async () => expect((await operations.get(first.id))?.status).toBe('waiting'));
    expect(storage.attempts).toHaveLength(1);
    expect(JSON.stringify(storage.records.values().next().value)).not.toContain('provider-secret');
    const second = await operations.start('test_jev');
    expect(second.id).toBe(first.id);
    expect(runner).toHaveBeenCalledTimes(1);
    expect((await operations.get(first.id))?.failure?.outcome).toBe('unknown');
  });
  it('commits bounded SSE diagnostics for Pi tests without bypassing the cooldown', async () => {
    const runner: OperationRunner = async (operation, recordFailure) => {
      const f = failureMetadata(new RequestFault('transient', { status: 200, outcome: 'unknown',
        providerErrorCode: 'server_error', streamEvent: 'error' }), operation.id, 'pi', operation.attempt, 901833);
      await recordFailure(f);
      throw new Error('PRIVATE_PROVIDER_INPUT');
    };
    operations = new Operations(runner);
    const first = await operations.start('test_pi');
    await vi.waitFor(async () => expect((await operations.get(first.id))?.status).toBe('waiting'));
    expect(JSON.stringify(storage.attempts)).toContain('server_error');
    expect(JSON.stringify(storage.attempts)).not.toContain('PRIVATE_');
    const stored = await operations.get(first.id);
    expect(Date.parse(stored?.nextRetryAt ?? '') - Date.parse(stored?.updatedAt ?? '')).toBeGreaterThanOrEqual(299_000);
    expect((await operations.start('test_pi')).id).toBe(first.id);
    expect(storage.attempts).toHaveLength(1);
  });
  it('resumes due model tests after the persisted wait', async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const operation: Operation = { id: '946b26ea-14f9-473d-8a1f-6bf47b15b62a', kind: 'test_pi', status: 'waiting', attempt: 1,
      createdAt: now, updatedAt: now, nextRetryAt: new Date(Date.now() + 10_000).toISOString(), message: 'Waiting.', failure: null };
    storage.records.set(`web_operation:${operation.id}`, operation);
    const runner = vi.fn(async () => {});
    operations = new Operations(runner);
    await operations.resume();
    expect(runner).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(runner).toHaveBeenCalledTimes(1);
    expect((await operations.get(operation.id))?.attempt).toBe(2);
    expect((await operations.get(operation.id))?.status).toBe('succeeded');
  });
  it('does not immediately repeat requests whose outcome is unknown after restart', async () => {
    const now = new Date().toISOString();
    const operation: Operation = { id: '946b26ea-14f9-473d-8a1f-6bf47b15b62a', kind: 'test_embedding', status: 'running', attempt: 1,
      createdAt: now, updatedAt: now, nextRetryAt: null, message: 'Running.', failure: null };
    storage.records.set(`web_operation:${operation.id}`, operation);
    const runner = vi.fn(async () => {});
    operations = new Operations(runner);
    await operations.resume();
    expect(runner).not.toHaveBeenCalled();
    expect((await operations.get(operation.id))?.status).toBe('waiting');
    expect(Date.parse((await operations.get(operation.id))?.nextRetryAt ?? '')).toBeGreaterThan(Date.now() + 290_000);
  });
  it.each([5, 10])('uses the configured cap when attempt %i is interrupted by restart', async attempt => {
    const now = new Date().toISOString();
    const operation: Operation = { id: '946b26ea-14f9-473d-8a1f-6bf47b15b62a', kind: 'test_embedding',
      status: 'running', attempt, createdAt: now, updatedAt: now, nextRetryAt: null, message: 'Running.', failure: null };
    storage.records.set(`web_operation:${operation.id}`, operation);
    const runner = vi.fn(async () => {});
    operations = new Operations(runner, undefined, async () => 10);
    await operations.resume();
    const restored = await operations.get(operation.id);
    expect(runner).not.toHaveBeenCalled();
    expect(restored?.status).toBe(attempt < 10 ? 'waiting' : 'failed');
    if (attempt < 10) expect(Date.parse(restored?.nextRetryAt ?? '')).toBeGreaterThan(Date.now() + 290_000);
    else expect(restored?.nextRetryAt).toBeNull();
  });
  it.each([5, 10])('persists the configured retry decision for UI test attempt %i', async attempt => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const operation: Operation = { id: '946b26ea-14f9-473d-8a1f-6bf47b15b62a', kind: 'test_jev',
      status: 'waiting', attempt: attempt - 1, createdAt: now, updatedAt: now, nextRetryAt: now,
      message: 'Waiting.', failure: null };
    storage.records.set(`web_operation:${operation.id}`, operation);
    const runner: OperationRunner = async (current, recordFailure) => {
      await recordFailure(failure(current));
      throw new Error('synthetic failure');
    };
    operations = new Operations(runner, undefined, async () => 10);
    await operations.resume();
    await vi.advanceTimersByTimeAsync(2000);
    const result = await operations.get(operation.id);
    expect(result?.attempt).toBe(attempt);
    expect(result?.status).toBe(attempt < 10 ? 'waiting' : 'failed');
    expect(storage.attempts).toHaveLength(1);
    if (attempt === 10) {
      expect(result?.nextRetryAt).toBeNull();
      expect(storage.attempts[0]?.[6]).toBeNull();
    }
  });
  it('caps throttled UI tests', async () => {
    const runner: OperationRunner = async (operation, recordFailure) => {
      await recordFailure({ ...failure(operation), kind: 'throttled' });
      throw new Error('synthetic rate limit');
    };
    operations = new Operations(runner, undefined, async () => 1);
    const current = await operations.start('test_pi');
    await vi.waitFor(async () => expect((await operations.get(current.id))?.status).toBe('failed'));
    expect((await operations.get(current.id))?.nextRetryAt).toBeNull();
  });
  it('observes a waiting collection without resubmitting it, and reports a later batch failure', async () => {
    vi.useFakeTimers();
    const batchId = '946b26ea-14f9-473d-8a1f-6bf47b15b62a';
    let failed = false;
    const runner = vi.fn<OperationRunner>(async operation => {
      operation.batchId = batchId;
      return { status: 'waiting', message: 'Batch waiting.', nextRetryAt: new Date(Date.now() + 1000).toISOString() };
    });
    const observer = vi.fn(async () => ({ status: failed ? 'failed' as const : 'waiting' as const,
      message: failed ? 'Batch failed.' : 'Batch waiting.', nextRetryAt: failed ? null : new Date(Date.now() + 1000).toISOString() }));
    operations = new Operations(runner, observer);
    const current = await operations.start('collection');
    await vi.advanceTimersByTimeAsync(0);
    expect((await operations.get(current.id))?.status).toBe('waiting');
    await operations.start('collection');
    await operations.resume();
    await vi.advanceTimersByTimeAsync(4000);
    expect(runner).toHaveBeenCalledTimes(1);
    failed = true;
    expect((await operations.get(current.id))?.status).toBe('failed');
    expect((await operations.get(current.id))?.message).toBe('Batch failed.');
    expect(storage.attempts).toHaveLength(0);
  });
  it('keeps partial completion terminal and upgrades legacy success without resubmitting', async () => {
    const now = new Date().toISOString();
    const current: Operation = { id: '268e2059-7fdd-48db-9525-3b16a5f5a6e6', batchId: '946b26ea-14f9-473d-8a1f-6bf47b15b62a',
      kind: 'collection', status: 'succeeded', attempt: 1, createdAt: now, updatedAt: now, nextRetryAt: null, message: 'Completed.', failure: null };
    storage.records.set(`web_operation:${current.id}`, current);
    const runner = vi.fn<OperationRunner>(async () => {});
    const observer = vi.fn(async () => ({ status: 'completed_with_errors' as const, message: 'Completed with 2 withheld items.' }));
    operations = new Operations(runner, observer);
    expect((await operations.get(current.id))?.status).toBe('completed_with_errors');
    expect((await operations.get(current.id))?.message).toContain('2 withheld items');
    await operations.resume();
    expect(runner).not.toHaveBeenCalled();
    expect(observer).toHaveBeenCalledTimes(1);
  });
  it('preserves an older failed operation and its diagnostics after the batch resumes', async () => {
    const now = new Date().toISOString();
    const current: Operation = { id: '268e2059-7fdd-48db-9525-3b16a5f5a6e6', batchId: '946b26ea-14f9-473d-8a1f-6bf47b15b62a',
      kind: 'collection', status: 'failed', attempt: 1, createdAt: now, updatedAt: now, nextRetryAt: null,
      message: 'Earlier attempt failed.', failure: { kind: 'invalid_output', outcome: 'unknown', durationMs: 6004 } };
    storage.records.set(`web_operation:${current.id}`, current);
    const observer = vi.fn(async () => ({ status: 'succeeded' as const, message: 'Batch completed.' }));
    operations = new Operations(async () => {}, observer);
    expect(await operations.get(current.id)).toEqual(current);
    expect(observer).not.toHaveBeenCalled();
  });
  it.each(['failed', 'completed', 'partial'] as const)(
    'reconciles a lease-contended digest to %s through get/list/poll without another dispatch', async phase => {
      vi.useFakeTimers();
      storage.digest = { phase: 'waiting', code: 'lease_busy', totalAttempts: 4, retryEpoch: 2,
        next: new Date(Date.now() + 1000).toISOString() };
      storage.digestUpdatedAt = new Date().toISOString();
      const run = vi.fn(async () => {});
      const runner = vi.fn<OperationRunner>(operation => runDigestOperation(operation, run));
      operations = new Operations(runner, observeDigest);
      const current = await operations.start('digest');
      await vi.advanceTimersByTimeAsync(0);
      expect((await operations.get(current.id))?.status).toBe('waiting');
      expect((await operations.start('digest')).id).toBe(current.id);
      expect(runner).toHaveBeenCalledTimes(1);
      await operations.resume();
      await vi.advanceTimersByTimeAsync(4000);
      expect(runner).toHaveBeenCalledTimes(1);
      storage.digestUpdatedAt = new Date().toISOString();
      storage.digest = phase === 'failed'
        ? { phase: 'failed', code: 'context_limit', next: null, totalAttempts: 5, retryEpoch: 2,
          reason: 'SECRET invalid request body' }
        : { phase: 'completed', next: null, completedStories: 8, failedStories: phase === 'partial' ? 3 : 0,
          totalAttempts: 5, retryEpoch: 2, completedAt: storage.digestUpdatedAt };
      // The observer timer must persist the terminal outcome even without a browser read.
      await vi.advanceTimersByTimeAsync(2000);
      const expected = phase === 'partial' ? 'completed_with_errors' : phase === 'completed' ? 'succeeded' : 'failed';
      expect(storage.records.get(`web_operation:${current.id}`)).toMatchObject({ status: expected, nextRetryAt: null });
      const result = await operations.get(current.id);
      expect(result?.status).toBe(expected);
      expect((await operations.list()).find(item => item.id === current.id)?.status).toBe(expected);
      if (phase === 'partial') expect(result?.message).toContain('8 stories; 3 withheld');
      expect(JSON.stringify(result)).not.toContain('SECRET');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledTimes(1);
      expect(storage.attempts).toHaveLength(0);
      if (phase === 'failed') {
        const replacement = await operations.start('digest');
        expect(replacement.id).not.toBe(current.id);
        await vi.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(2);
      }
    },
  );
  it('reconciles a legacy waiting digest after restart without resubmitting invalid work', async () => {
    vi.useFakeTimers();
    const now = new Date().toISOString();
    const current: Operation = { id: '268e2059-7fdd-48db-9525-3b16a5f5a6e6', kind: 'digest',
      status: 'waiting', attempt: 1, createdAt: now, updatedAt: now, nextRetryAt: null,
      message: 'Digest waiting.', failure: null };
    storage.records.set(`web_operation:${current.id}`, current);
    storage.digest = { phase: 'failed', code: 'context_limit', next: null, totalAttempts: 6, retryEpoch: 1 };
    storage.digestUpdatedAt = now;
    const runner = vi.fn<OperationRunner>(async () => {});
    operations = new Operations(runner, observeDigest);
    await operations.resume();
    expect((await operations.get(current.id))?.status).toBe('failed');
    await vi.advanceTimersByTimeAsync(6000);
    expect(runner).not.toHaveBeenCalled();
  });
  it('persists digest binding progress even when the public wait message is unchanged', async () => {
    vi.useFakeTimers();
    storage.digest = { phase: 'waiting', totalAttempts: 4, retryEpoch: 2, next: null };
    storage.digestUpdatedAt = new Date().toISOString();
    operations = new Operations(operation => runDigestOperation(operation, async () => {}), observeDigest);
    const current = await operations.start('digest');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    storage.digest = { phase: 'waiting', totalAttempts: 5, retryEpoch: 2, next: null };
    storage.digestUpdatedAt = new Date().toISOString();
    expect((await operations.get(current.id))?.digestRun).toMatchObject({ totalAttempts: 5 });
    expect(storage.records.get(`web_operation:${current.id}`)).toMatchObject({ digestRun: { totalAttempts: 5 } });
  });
  it('does not save unexpected exception messages', async () => {
    operations = new Operations(async () => { throw new Error('secret redirect URL'); });
    const operation = await operations.start('refresh_sources');
    await vi.waitFor(async () => expect((await operations.get(operation.id))?.status).toBe('failed'));
    expect(JSON.stringify(await operations.get(operation.id))).not.toContain('secret redirect URL');
  });
});
