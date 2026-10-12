import { beforeEach, expect, it, vi } from 'vitest';
import { PostgresSourceCollectionStore } from './collection-store.js';
import { primaryCursorSchema } from './config.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
const store = new PostgresSourceCollectionStore();
beforeEach(() => { vi.resetAllMocks(); });

it('locks source before batch and rejects a collector using configuration from before an edit', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ collection_config_version: 2 }] });
  await expect(store.commitProgress('batch', { id: 'source', configVersion: 1 }, [],
    primaryCursorSchema.parse({}), false)).rejects.toMatchObject({ code: 'primary_store_config_changed' });
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(mocks.query.mock.calls[0]?.[0]).toContain('FROM sources WHERE id=$1 FOR UPDATE');
});

it('checkpoints publisher discovery and batch cursor in the same transaction with the configuration fence', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ collection_config_version: 2 }] })
    .mockResolvedValueOnce({ rows: [{ status: 'pending' }] }).mockResolvedValue({ rows: [] });
  const cursor = primaryCursorSchema.parse({ cutoff: '2026-10-01T12:00:00.000Z' });
  expect(await store.commitProgress('batch', { id: 'source', configVersion: 2 }, [], cursor, false)).toBe(0);
  expect(mocks.query.mock.calls[0]?.[0]).toContain('FROM sources');
  expect(mocks.query.mock.calls[1]?.[0]).toContain('FROM batch_sources');
  expect(mocks.query.mock.calls[2]?.[0]).toContain('UPDATE sources');
  expect(mocks.query.mock.calls[3]?.[0]).toContain('UPDATE batch_sources');
  expect(mocks.query.mock.calls[2]?.[1]?.[1]).toBe(JSON.stringify(cursor));
  expect(mocks.query.mock.calls[3]?.[1]?.[2]).toBe(JSON.stringify(cursor));
});
