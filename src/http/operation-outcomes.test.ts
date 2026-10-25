import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeCollection, runCollectionOperation, observeDigest, runDigestOperation, type Operation } from './operations.js';

const query = vi.hoisted(() => vi.fn<(sql: string, parameters?: unknown[]) => Promise<{ rows: unknown[] }>>());
vi.mock('../db.js', () => ({ db: { query } }));

describe('collection outcomes', () => {
  const batchId = '946b26ea-14f9-473d-8a1f-6bf47b15b62a';
  const next = new Date('2099-01-01T00:00:00.000Z');
  const operation = (): Operation => ({ id: '268e2059-7fdd-48db-9525-3b16a5f5a6e6', kind: 'collection', status: 'running',
    attempt: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    nextRetryAt: null, message: 'Running.', failure: null });
  function batch(status: string) { return { id: batchId, status, next_retry_at: status === 'waiting' ? next : null, error_code: null, failed_items: 0 }; }
  beforeEach(() => { query.mockReset(); });

  describe('collection operation reporting', () => {
    it.each(['collecting', 'processing', 'waiting', 'failed', 'completed'])('follows persisted %s state instead of assuming success', async status => {
      query.mockResolvedValueOnce({ rows: [{ id: batchId }] }).mockResolvedValueOnce({ rows: [{ id: batchId }] })
        .mockResolvedValueOnce({ rows: [batch(status)] });
      const current = operation();
      const result = await runCollectionOperation(current, async () => {});
      expect(current.batchId).toBe(batchId);
      expect(result.status).toBe(status === 'completed' ? 'succeeded' : status === 'processing' || status === 'collecting' ? 'running' : status);
      expect(result.nextRetryAt ?? null).toBe(status === 'waiting' ? next.toISOString() : null);
    });
    it.each([1, 3])('reports partial completion with %i withheld items, never full success', async count => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: batchId }] })
        .mockResolvedValueOnce({ rows: [{ ...batch('completed'), error_code: 'partial_item_failure', failed_items: count }] });
      const result = await runCollectionOperation(operation(), async () => {});
      expect(result.status).toBe('completed_with_errors');
      expect(result.message).toContain(`Completed with ${count} withheld`);
      expect(result.message).toContain('explicit correction');
    });
    it('reports story partial completion even when extraction items completed', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: batchId }] })
        .mockResolvedValueOnce({ rows: [{ ...batch('completed'), error_code: 'partial_story_failure', failed_items: 0 }] });
      const result = await runCollectionOperation(operation(), async () => {});
      expect(result.status).toBe('completed_with_errors');
      expect(result.message).toContain('withheld stories');
    });
    it('preserves waiting state when a provider error was saved by the pipeline', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: batchId }] }).mockResolvedValueOnce({ rows: [{ id: batchId }] })
        .mockResolvedValueOnce({ rows: [batch('waiting')] });
      const result = await runCollectionOperation(operation(), async () => { throw new Error('private provider error'); });
      expect(result.status).toBe('waiting');
      expect(result.message).not.toContain('private');
    });
    it('does not report success when post-batch work fails', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: batchId }] })
        .mockResolvedValueOnce({ rows: [batch('completed')] });
      const result = await runCollectionOperation(operation(), async () => { throw new Error('private follow-up error'); });
      expect(result.status).toBe('failed');
      expect(result.message).not.toContain('private');
    });
    it('reports skipped work without a batch as a failed request, not completed', async () => {
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      expect((await runCollectionOperation(operation(), async () => {})).status).toBe('failed');
    });
    it('does not reinterpret expired history or model test operations', async () => {
      const current = operation(); current.batchId = batchId;
      query.mockResolvedValueOnce({ rows: [] });
      expect(await observeCollection(current)).toBeUndefined();
      current.kind = 'test_jev';
      expect(await observeCollection(current)).toBeUndefined();
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});

describe('digest outcomes', () => {
  const startedAt = '2026-01-02T00:00:00.000Z';
  const updatedAt = '2026-01-02T00:01:00.000Z';
  let operation: Operation;
  function report(value: unknown, at = updatedAt, newerManual = false) {
    query.mockResolvedValue({ rows: [{ value, updated_at: new Date(at), newer_manual: newerManual }] });
  }
  beforeEach(() => {
    query.mockReset();
    operation = { id: '946b26ea-14f9-473d-8a1f-6bf47b15b62a', kind: 'digest', status: 'waiting',
      attempt: 1, createdAt: startedAt, updatedAt: startedAt, nextRetryAt: null, message: 'Waiting.', failure: null };
  });

  it('reports partial work with explicit counts and binds the durable state', async () => {
    report({ phase: 'completed', completedStories: 20, failedStories: 1, totalAttempts: 4, retryEpoch: 2 });
    expect(await runDigestOperation(operation, async () => {})).toEqual({
      status: 'completed_with_errors', message: 'Digest refreshed 20 stories; 1 withheld after validation failures.',
    });
    expect(operation.digestRun).toEqual({ retryEpoch: 2, totalAttempts: 4, updatedAt });
  });
  it('keeps skipped failures visible on completed refreshes', async () => {
    report({ phase: 'completed', completedStories: 0, failedStories: 1, skippedStories: 1 });
    expect((await runDigestOperation(operation, async () => {})).status).toBe('completed_with_errors');
  });
  it.each(['waiting', 'running', 'failed'])('does not label a %s digest successful', async phase => {
    report({ phase, next: null });
    expect((await runDigestOperation(operation, async () => {})).status).toBe(phase === 'failed' ? 'failed' : 'waiting');
  });
  it('propagates provider failures without replacing them with a partial warning', async () => {
    const error = new Error('provider failure');
    await expect(runDigestOperation(operation, async () => { throw error; })).rejects.toBe(error);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'])('does not reuse an older %s report after lease contention', async phase => {
    report({ phase }, '2026-01-01T00:00:00.000Z');
    expect((await runDigestOperation(operation, async () => {})).status).toBe('waiting');
    expect(operation.digestRun).toBeUndefined();
    expect(await observeDigest(operation)).toBeUndefined();
  });
  it('reports success for completed work without failures', async () => {
    report({ phase: 'completed', completedStories: 2, failedStories: 0 });
    expect((await runDigestOperation(operation, async () => {})).status).toBe('succeeded');
  });
  it('binds an existing lease wait and observes a later terminal context failure without running again', async () => {
    const run = vi.fn(async () => {});
    report({ phase: 'waiting', retryEpoch: 2, totalAttempts: 4, next: updatedAt }, '2026-01-01T23:59:00.000Z');
    expect((await runDigestOperation(operation, run)).status).toBe('waiting');
    report({ phase: 'failed', retryEpoch: 2, totalAttempts: 5, code: 'context_limit', next: null, reason: 'SECRET provider input' });
    expect(await observeDigest(operation)).toEqual({ status: 'failed', nextRetryAt: null,
      message: 'Digest refresh failed. Correct the pipeline failure before starting a new manual refresh.' });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([0, 3])('observes background completion with %i withheld stories', async failedStories => {
    report({ phase: 'waiting', retryEpoch: 2, totalAttempts: 4 });
    await runDigestOperation(operation, async () => {});
    report({ phase: 'completed', retryEpoch: 2, totalAttempts: 5, completedStories: 8, failedStories });
    const result = await observeDigest(operation);
    expect(result?.status).toBe(failedStories ? 'completed_with_errors' : 'succeeded');
    if (failedStories) expect(result?.message).toContain('8 stories; 3 withheld');
  });
  it('tracks running/lease-deferred state without consuming a retry or bypassing its wait', async () => {
    report({ phase: 'waiting', retryEpoch: 2, totalAttempts: 4, next: updatedAt });
    await runDigestOperation(operation, async () => {});
    report({ phase: 'running', retryEpoch: 2, totalAttempts: 5, next: null });
    expect((await observeDigest(operation))?.status).toBe('waiting');
    expect(operation.digestRun?.totalAttempts).toBe(4);
    report({ phase: 'waiting', retryEpoch: 2, totalAttempts: 4, code: 'lease_busy', next: updatedAt });
    expect(await observeDigest(operation)).toMatchObject({ status: 'waiting', nextRetryAt: updatedAt });
  });
  it.each([
    { phase: 'completed', retryEpoch: 3, totalAttempts: 5 },
    { phase: 'failed', retryEpoch: 2, totalAttempts: 8 },
    { phase: 'completed', retryEpoch: 2, totalAttempts: 3 },
  ])('does not adopt a different run or skipped counters %j', async value => {
    report({ phase: 'waiting', retryEpoch: 2, totalAttempts: 4 });
    await runDigestOperation(operation, async () => {});
    report(value);
    expect(await observeDigest(operation)).toBeUndefined();
  });
  it('does not adopt reports owned by a newer manual digest', async () => {
    report({ phase: 'completed' }, updatedAt, true);
    expect(await observeDigest(operation)).toBeUndefined();
    expect((await runDigestOperation(operation, async () => {})).status).toBe('waiting');
    expect(operation.digestRun).toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain('newer_manual');
  });
  it('reconciles legacy unbound waits only from state updated since their creation', async () => {
    report({ phase: 'failed', code: 'context_limit', next: null });
    expect((await observeDigest(operation))?.status).toBe('failed');
  });
  it('does not read or reinterpret other operation kinds or terminal attempts', async () => {
    operation.kind = 'collection';
    expect(await observeDigest(operation)).toBeUndefined();
    operation.kind = 'digest'; operation.status = 'failed';
    expect(await observeDigest(operation)).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
