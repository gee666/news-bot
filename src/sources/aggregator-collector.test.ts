import { beforeEach, expect, it, vi } from 'vitest';
import { collectPublisher, publisherReader } from './collector.js';
import { primarySourceInput, type PrimarySource } from './config.js';
import type { ResearchPage } from '../pipeline/research-page.js';
import type { SourceCollectedItem } from './types.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), article: vi.fn() }));
vi.mock('../pipeline/research-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('../pipeline/research-fetch.js')>(), fetchPublic: mocks.fetch,
}));
vi.mock('../pipeline/research-page.js', () => ({ fetchPage: mocks.article }));
const source: PrimarySource = { id: '11111111-1111-4111-8111-111111111111', cursor: {},
  ...primarySourceInput.parse({ kind: 'feed', name: 'Hacker News', publisher: 'Hacker News',
    url: 'https://hnrss.org/newest', articlePathPrefixes: ['/'], articleLinkPolicy: 'external' }) };
const cutoff = new Date('2026-10-01T12:00:00Z');
const articleUrl = 'https://example.org/release';
const canonicalUrl = 'https://www.example.org/release';
const xml = '<rss><channel><item><guid isPermaLink="false">hn-42</guid><link>' + articleUrl +
  '</link><title>Release</title><pubDate>Thu, 01 Oct 2026 11:00:00 GMT</pubDate></item></channel></rss>';
const page: ResearchPage = { url: articleUrl, canonicalUrl, title: 'Release', content: 'Read article body, not the RSS summary.',
  access: 'public', metadata: { status: 200 } };
const commitProgress = vi.fn(async (_batch: string, _source: { id: string }, items: readonly SourceCollectedItem[],
  cursor: object, completed: boolean) => {
  expect(cursor).toHaveProperty('backlog'); expect(typeof completed).toBe('boolean');
  return items.length;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockResolvedValue({ url: source.url, status: 200, contentType: 'application/rss+xml', text: xml });
  mocks.article.mockResolvedValue(page);
});

it('reads and persists an opted-in external article with a public cross-host canonical redirect', async () => {
  expect(await collectPublisher(publisherReader, { commitProgress }, 'batch', source, cutoff)).toBe(1);
  expect(mocks.article).toHaveBeenCalledWith(articleUrl);
  expect(commitProgress.mock.calls.flatMap(call => call[2])[0]).toMatchObject({ externalId: 'hn-42', originalUrl: articleUrl,
    originalText: '# Release\n\nRead article body, not the RSS summary.',
    metadata: { canonicalUrl, connectorKind: 'feed', publisher: 'Hacker News' } });
});

it('keeps submission time separate from actual article publication and does not rejuvenate old articles', async () => {
  mocks.article.mockResolvedValue({ ...page, publishedAt: '2020-01-01T00:00:00Z' });
  expect(await collectPublisher(publisherReader, { commitProgress }, 'batch',
    { ...source, feedDateRole: 'submission', unknownPublication: 'collect_once' }, cutoff)).toBe(0);
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toEqual([]);
});

it('records HN submission provenance without inventing publication for undated collect_once articles', async () => {
  expect(await collectPublisher(publisherReader, { commitProgress }, 'batch',
    { ...source, feedDateRole: 'submission', unknownPublication: 'collect_once' }, cutoff)).toBe(1);
  expect(commitProgress.mock.calls.flatMap(call => call[2])[0]).toMatchObject({ publishedAt: null,
    metadata: { submittedAt: '2026-10-01T11:00:00.000Z', feedEntryPublishedAt: '2026-10-01T11:00:00.000Z',
      publicationKnown: false, publicationBasis: 'unknown_collect_once' } });
});

it('retains both HN submission and publisher timestamps for eligible dated articles', async () => {
  mocks.article.mockResolvedValue({ ...page, publishedAt: '2026-10-01T09:00:00Z' });
  expect(await collectPublisher(publisherReader, { commitProgress }, 'batch',
    { ...source, feedDateRole: 'submission' }, cutoff)).toBe(1);
  expect(commitProgress.mock.calls.flatMap(call => call[2])[0]).toMatchObject({ publishedAt: new Date('2026-10-01T09:00:00Z'),
    metadata: { submittedAt: '2026-10-01T11:00:00.000Z', publicationBasis: 'article_metadata' } });
});

it('does not read external feed entries without opt-in', async () => {
  expect(await collectPublisher(publisherReader, { commitProgress }, 'batch',
    { ...source, articleLinkPolicy: 'same_host' }, cutoff)).toBe(0);
  expect(mocks.article).not.toHaveBeenCalled();
});

it('rejects cross-host canonicals on a default publisher feed', async () => {
  const local = { ...source, url: 'https://example.org/feed', articleLinkPolicy: 'same_host' as const };
  mocks.fetch.mockResolvedValue({ url: local.url, status: 200, contentType: 'application/rss+xml', text: xml });
  await expect(collectPublisher(publisherReader, { commitProgress }, 'batch', local, cutoff))
    .rejects.toThrow('publisher_article_failed');
  expect(mocks.article).toHaveBeenCalledWith(articleUrl);
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toEqual([]);
  expect(commitProgress.mock.calls.every(call => call[4] === false)).toBe(true);
});

it.each(['http://10.0.0.1/release', 'http://[::1]/release', 'http://service.internal/release',
  'https://user:pw@example.org/release', 'file:///etc/passwd'])('rejects unsafe opted-in canonical %s', async url => {
  mocks.article.mockResolvedValue({ ...page, canonicalUrl: url });
  await expect(collectPublisher(publisherReader, { commitProgress }, 'batch', source, cutoff))
    .rejects.toThrow('publisher_article_failed');
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toEqual([]);
  expect(commitProgress.mock.calls.every(call => call[4] === false)).toBe(true);
});

it('retains path restrictions for external canonical redirects', async () => {
  mocks.fetch.mockResolvedValue({ url: source.url, status: 200, contentType: 'application/rss+xml',
    text: xml.replace(articleUrl, articleUrl + '/story') });
  mocks.article.mockResolvedValue({ ...page, canonicalUrl: 'https://www.example.org/' });
  await expect(collectPublisher(publisherReader, { commitProgress }, 'batch',
    { ...source, articlePathPrefixes: ['/release/'] }, cutoff)).rejects.toThrow('publisher_article_failed');
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toEqual([]);
  expect(commitProgress.mock.calls.every(call => call[4] === false)).toBe(true);
});

it('does not persist a read blocked by fetch-time DNS/private-network checks', async () => {
  mocks.article.mockResolvedValue({ ...page, access: 'unavailable', canonicalUrl: null, content: null,
    metadata: { error: 'blocked_url' } });
  await expect(collectPublisher(publisherReader, { commitProgress }, 'batch', source, cutoff))
    .rejects.toThrow('publisher_article_failed');
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toEqual([]);
  expect(commitProgress.mock.calls.every(call => call[4] === false)).toBe(true);
});

it('does not allow the feed index to redirect off-host even when articles opt in', async () => {
  mocks.fetch.mockResolvedValue({ url: 'https://other.org/newest', status: 200, contentType: 'application/rss+xml', text: xml });
  await expect(publisherReader.index(source)).rejects.toThrow();
  expect(mocks.article).not.toHaveBeenCalled();
});
