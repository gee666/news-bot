import { beforeEach, expect, it, vi } from 'vitest';
import { collectPrimarySources } from './collector.js';
import { collectionError } from './collector-errors.js';
import { defaultSettings } from '../settings.js';
import { primarySourceInput } from './config.js';
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), fetch: vi.fn(), crawl: vi.fn(), commit: vi.fn(), query: vi.fn() }));
vi.mock('./repository.js', () => ({ preparePrimarySources: mocks.prepare }));
vi.mock('./collection-store.js', () => ({ PostgresSourceCollectionStore: class { commitProgress = mocks.commit; } }));
vi.mock('../pipeline/research-fetch.js', async original => ({ ...await original<typeof import('../pipeline/research-fetch.js')>(), fetchPublic: mocks.fetch }));
vi.mock('../pipeline/crawler-client.js', () => ({ fetchCrawlerPage: mocks.crawl }));
vi.mock('../pipeline/research-page.js', () => ({ fetchPage: mocks.crawl }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  const config = primarySourceInput.parse({ kind: 'feed', name: 'Publisher', publisher: 'Publisher',
    url: 'https://example.org/feed', articlePathPrefixes: ['/news/'] });
  mocks.prepare.mockResolvedValue(['failed-source', 'healthy-source'].map(id => ({ ...config, id,
    cursor: { cutoff: null, unknownIds: [], completedIds: [] } })));
  mocks.fetch.mockRejectedValueOnce(new Error('upstream secret-body')).mockResolvedValueOnce({ status: 200,
    url: config.url, text: '<rss><channel><item><link>https://example.org/news/release</link><pubDate>2026-09-30T12:00:00Z</pubDate></item></channel></rss>' });
  mocks.crawl.mockResolvedValue({ access: 'public', canonicalUrl: 'https://example.org/news/release',
    content: '# Release\n$500 25x', title: 'Release', publishedAt: null, metadata: { status: 200 } });
  mocks.commit.mockImplementation(async (_batch, _source, items: readonly unknown[]) => items.length);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('COUNT(*)') ? [{ collected: 1 }] : [] }));
});
it('reports invalid-configuration sources and saved items from durable batch state even with no valid subscriptions', async () => {
  mocks.prepare.mockResolvedValue([]);
  mocks.query.mockResolvedValue({ rows: [{ collected: 2, failed: 1 }] });
  expect(await collectPrimarySources('batch', new Date('2026-10-01T12:00:00Z'), defaultSettings)).toEqual({ collected: 2, failed: 1 });
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
});

it('isolates a failed publisher and keeps healthy source progress scheduled in the same batch', async () => {
  expect(await collectPrimarySources('batch', new Date('2026-10-01T12:00:00Z'), defaultSettings)).toEqual({ collected: 1, failed: 1 });
  expect(mocks.commit.mock.calls.flatMap(call => call[2])).toHaveLength(1);
  expect(mocks.commit.mock.calls.at(-1)?.[4]).toBe(true);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', 'failed-source', 'primary_index_failed']);
  expect(mocks.query.mock.calls[0]?.[0]).toContain("status <> 'completed'");
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain('secret-body');
});

it('preserves the legacy generic error message while adding a safe phase-specific code', () => {
  const failure = collectionError(new Error('primary_source_collection_failed'), 'index');
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('primary_source_collection_failed');
  expect(failure.code).toBe('primary_index_failed');
  expect(collectionError(failure, 'article')).toBe(failure);
});
