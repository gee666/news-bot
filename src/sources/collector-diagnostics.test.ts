import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ResearchFetchError } from '../pipeline/research-fetch.js';
import type { ResearchPage } from '../pipeline/research-page.js';
import { defaultSettings } from '../settings.js';
import { collectPrimarySources, collectPublisher, publisherReader } from './collector.js';
import { primarySourceInput, type PrimarySource } from './config.js';

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), fetch: vi.fn(), crawl: vi.fn(), article: vi.fn(), commit: vi.fn(), query: vi.fn() }));
vi.mock('./repository.js', () => ({ preparePrimarySources: mocks.prepare }));
vi.mock('./collection-store.js', () => ({ PostgresSourceCollectionStore: class { commitProgress = mocks.commit; } }));
vi.mock('../pipeline/research-fetch.js', async original => ({ ...await original<typeof import('../pipeline/research-fetch.js')>(), fetchPublic: mocks.fetch }));
vi.mock('../pipeline/crawler-client.js', () => ({ fetchCrawlerPage: mocks.crawl }));
vi.mock('../pipeline/research-page.js', () => ({ fetchPage: mocks.article }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));

const source: PrimarySource = { id: '11111111-1111-4111-8111-111111111111',
  ...primarySourceInput.parse({ kind: 'website', name: 'Publisher', publisher: 'Publisher',
    url: 'https://example.org/news/', articlePathPrefixes: ['/index/'], maxArticles: 2 }),
  cursor: { cutoff: '2026-10-07T19:00:00.000Z', completedIds: [], unknownIds: [] } };
const cutoff = new Date('2026-10-08T19:00:00Z');
const index: ResearchPage = { url: source.url, canonicalUrl: source.url, title: 'News', access: 'public',
  content: '[Latest Oct 8, 2026](/index/latest/)\n[Teens Oct 7, 2026](/index/teens/)\n[GPT Oct 7, 2026](/index/gpt/)',
  metadata: { status: 200 } };
const publicArticle: ResearchPage = { ...index, canonicalUrl: 'https://example.org/index/gpt/', content: '# Release\nArticle body.' };
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.prepare.mockResolvedValue([source]);
  mocks.crawl.mockResolvedValue(index);
  mocks.article.mockResolvedValue(publicArticle);
  mocks.commit.mockImplementation(async (_batch, _source, items: readonly unknown[]) => items.length);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('COUNT(*)') ? [{ collected: 0, failed: 1 }] : [] }));
});

afterEach(() => { vi.restoreAllMocks(); });

it.each([3, 7, 11, 15, 19])('records article HTTP403 at the %s:00 cutoff without changing selection or access checks', async hour => {
  mocks.article.mockResolvedValue({ ...publicArticle, access: 'restricted', content: null,
    metadata: { status: 403, crawlerError: 'crawler_render_failed' } });
  const batchCutoff = new Date(`2026-10-08T${String(hour).padStart(2, '0')}:00:00Z`);
  expect(await collectPrimarySources('batch', batchCutoff, defaultSettings)).toEqual({ collected: 0, failed: 1 });
  expect(mocks.article.mock.calls.map(call => call[0])).toEqual([
    'https://example.org/index/gpt/', 'https://example.org/index/teens/',
  ]);
  expect(mocks.commit.mock.calls.flatMap(call => call[2])).toEqual([]);
  expect(mocks.commit.mock.calls.every(call => call[4] === false)).toBe(true);
  expect(mocks.commit.mock.calls.at(-1)?.[3].backlog.filter((entry: { lastErrorCode: string | null }) => entry.lastErrorCode)).toHaveLength(2);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, 'primary_article_restricted_http_403']);
  expect(mocks.query.mock.calls[0]?.[0]).toContain("status <> 'completed'");
  expect(warn).toHaveBeenCalledWith('Primary source collection failed', {
    batchId: 'batch', sourceId: source.id, code: 'primary_article_restricted_http_403',
    phase: 'article', reason: 'restricted', access: 'restricted', status: 403, crawlerError: 'crawler_render_failed',
  });
});

it.each([
  ['restricted', 'crawler_restricted', 200, 'primary_index_restricted_http_200'],
  ['unavailable', 'crawler_timeout', undefined, 'primary_index_crawler_timeout'],
  ['unavailable', 'blocked_url', undefined, 'primary_index_blocked_url'],
] as const)('reports index %s/%s without reading articles', async (access, error, status, code) => {
  mocks.crawl.mockResolvedValue({ ...index, access, content: null, canonicalUrl: null, metadata: { error, status } });
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, code]);
  expect(mocks.article).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
});

it('rejects public index redirects outside the configured publisher', async () => {
  mocks.crawl.mockResolvedValue({ ...index, canonicalUrl: 'https://elsewhere.org/news/' });
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, 'primary_index_outside_publisher_http_200']);
  expect(mocks.article).not.toHaveBeenCalled();
});

it('retains the first failed article diagnostic while committing a later successful article', async () => {
  mocks.article.mockResolvedValueOnce({ ...publicArticle, access: 'restricted', content: null,
    metadata: { status: 403, error: 'crawler_restricted' } }).mockResolvedValueOnce(publicArticle);
  await expect(collectPublisher(publisherReader, { commitProgress: mocks.commit }, 'batch', source, cutoff))
    .rejects.toMatchObject({ message: 'publisher_article_failed', code: 'primary_article_restricted_http_403' });
  expect(mocks.commit.mock.calls.flatMap(call => call[2])).toHaveLength(1);
  expect(mocks.commit.mock.calls.at(-1)?.[3].completedIds).toEqual(['https://example.org/index/teens/']);
  expect(mocks.commit.mock.calls.every(call => call[4] === false)).toBe(true);
});

it('distinguishes persistence failure without exposing its message or completing the source', async () => {
  mocks.commit.mockRejectedValue(new Error('postgres://user:password@db/query-secret'));
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, 'primary_store_failed']);
  expect(mocks.commit.mock.calls.every(call => call[4] === false)).toBe(true);
  expect(JSON.stringify([warn.mock.calls, mocks.query.mock.calls])).not.toContain('password');
});

it('reports final completion persistence failure as store failure', async () => {
  mocks.crawl.mockResolvedValue({ ...index, content: 'No articles.' });
  mocks.commit.mockRejectedValue(new Error('secret database detail'));
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, 'primary_store_failed']);
});

it('drops arbitrary metadata errors, URLs, content and non-HTTP status from diagnostics', async () => {
  mocks.article.mockResolvedValue({ ...publicArticle, access: 'unavailable', content: 'secret response body',
    canonicalUrl: 'https://user:password@example.org/index/private/?token=secret',
    metadata: { status: 999, error: 'token=secret', crawlerError: 'crawler_timeout\nsecret' } });
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, 'primary_article_unavailable']);
  expect(JSON.stringify([warn.mock.calls, mocks.query.mock.calls])).not.toMatch(/secret|password|token=/u);
});

it.each([
  [new ResearchFetchError('blocked_url'), 'primary_index_blocked_url'],
  [new Error('authorization=secret'), 'primary_index_failed'],
])('exposes only safe thrown reader errors', async (error, code) => {
  mocks.crawl.mockRejectedValue(error);
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, code]);
  expect(JSON.stringify([warn.mock.calls, mocks.query.mock.calls])).not.toContain('secret');
});

it.each([
  [403, source.url, '<rss/>', 'primary_index_restricted_http_403'],
  [200, 'https://elsewhere.org/feed', '<rss/>', 'primary_index_outside_publisher_http_200'],
  [200, source.url, '<!DOCTYPE rss><rss/>', 'primary_index_invalid_feed_xml'],
])('retains safe feed status and parsing diagnostics', async (status, url, text, code) => {
  mocks.prepare.mockResolvedValue([{ ...source, kind: 'feed' }]);
  mocks.fetch.mockResolvedValue({ status, url, text });
  await collectPrimarySources('batch', cutoff, defaultSettings);
  expect(mocks.query.mock.calls[0]?.[1]).toEqual(['batch', source.id, code]);
  expect(mocks.article).not.toHaveBeenCalled();
});
