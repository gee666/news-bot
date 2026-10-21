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

it.each([
  [{ type: 'image', url: 'https://cdn.example.org/chart.jpg' }],
  [{ type: 'video', telegramMessageId: 42, telegramPeer: '-1001234', groupedId: '9007199254740993' }],
])('stores media descriptors in item and revision metadata for downstream joins: %j', async descriptor => {
  const itemId = '22222222-2222-4222-8222-222222222222';
  const revisionId = '33333333-3333-4333-8333-333333333333';
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.startsWith('SELECT status')) return { rows: [{ status: 'pending' }] };
    if (sql.includes('INSERT INTO source_items')) return { rows: [{ id: itemId, current_revision_id: null }] };
    if (sql.includes('INSERT INTO item_revisions')) return { rows: [{ id: revisionId }] };
    return { rows: [] };
  });
  const media = [descriptor];
  expect(await store.commitSource('batch', { id: 'source' }, [{ externalId: '42', originalText: 'caption', normalizedText: 'caption',
    originalUrl: null, publishedAt: new Date('2026-10-01T12:00:00Z'), editedAt: null, links: [], metadata: { media } }], {})).toBe(1);
  const itemMetadata = mocks.query.mock.calls.find(call => call[0].includes('INSERT INTO source_items'))?.[1]?.[4];
  const revisionMetadata = mocks.query.mock.calls.find(call => call[0].includes('INSERT INTO item_revisions'))?.[1]?.[4];
  expect(JSON.parse(String(itemMetadata)).media).toEqual(media);
  expect(JSON.parse(String(revisionMetadata)).media).toEqual(media);
  expect(mocks.query.mock.calls.find(call => call[0].includes('SET current_revision_id'))?.[1]).toEqual([itemId, revisionId]);
});
