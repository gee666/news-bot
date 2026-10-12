import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observeCollection, runCollectionOperation } from './collection-operation.js';
import type { Operation } from './operations.js';

const query = vi.hoisted(() => vi.fn<(sql: string, parameters?: unknown[]) => Promise<{ rows: unknown[] }>>());
vi.mock('../db.js', () => ({ db: { query } }));
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
