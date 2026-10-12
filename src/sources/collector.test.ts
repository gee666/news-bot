import { beforeEach, expect, it, vi } from 'vitest';
import { collectPublisher, type PrimaryReader } from './collector.js';
import { primarySourceInput, primaryCursorSchema, type PrimarySource } from './config.js';
import type { CrawlerPage } from '../pipeline/crawler-client.js';

const source: PrimarySource = { id: '11111111-1111-4111-8111-111111111111',
  ...primarySourceInput.parse({ kind: 'feed', name: 'Publisher', publisher: 'Publisher',
    url: 'https://example.org/feed', articlePathPrefixes: ['/news/'], maxArticles: 2 }),
  cursor: { cutoff: null, completedIds: [], unknownIds: [] } };
const cutoff = new Date('2026-10-01T12:00:00Z');
const page: CrawlerPage = { url: 'https://example.org/news/release', canonicalUrl: 'https://example.org/news/release',
  title: 'Release', content: '# Release\nPrice $500 | 25x | 300 tokens/sec', access: 'public', publishedAt: null, metadata: { status: 200 } };
const commitProgress = vi.fn().mockImplementation(async (_batch, _source, items: readonly unknown[]) => items.length);
const reader: PrimaryReader = { index: vi.fn(), article: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reader.article).mockResolvedValue(page);
  vi.mocked(reader.index).mockResolvedValue([{ id: 'guid1', url: page.url, title: 'Release', publishedAt: new Date('2026-09-30T12:00:00Z') }]);
});
it('collects four eligible entries across cutoffs then revisits edits within the same budget', async () => {
  const entries = [4, 3, 2, 1].map(id => ({ id: 'guid'+id, url: page.url+'-'+id, title: null,
    publishedAt: new Date(cutoff.getTime() - (5 - id) * 3600000) }));
  vi.mocked(reader.index).mockResolvedValue(entries);
  let cursor = primaryCursorSchema.parse(source.cursor);
  for (let batch = 0; batch < 3; batch++) {
    const start = commitProgress.mock.calls.length;
    vi.mocked(reader.article).mockImplementation(async url => ({ ...page, url, canonicalUrl: url,
      content: batch === 2 && url.endsWith('-1') ? 'Edited price $600' : page.content }));
    await collectPublisher(reader, { commitProgress }, 'batch'+batch, { ...source, cursor },
      new Date(cutoff.getTime() + batch * 3600000));
    const calls = commitProgress.mock.calls.slice(start);
    const items = calls.flatMap(call => call[2]);
    expect(items.map(item => item.externalId)).toEqual(batch === 0 ? ['guid1', 'guid2']
      : batch === 1 ? ['guid3', 'guid4'] : ['guid1', 'guid2']);
    if (batch === 2) expect(items[0]?.originalText).toContain('Edited price $600');
    cursor = primaryCursorSchema.parse(calls.at(-1)?.[3]);
  }
  expect(reader.article).toHaveBeenCalledTimes(6);
});
it('reserves an edit check every third backlog batch and rotates known entries', async () => {
  let cursor = primaryCursorSchema.parse(source.cursor);
  for (let batch = 0; batch < 6; batch++) {
    const entries = Array.from({ length: 4 + batch * 2 }, (_, index) => ({ id: 'guid'+(index + 1),
      url: page.url+'-'+(index + 1), title: null, publishedAt: new Date(cutoff.getTime() - 3600000 + index * 1000) }));
    vi.mocked(reader.index).mockResolvedValue(entries);
    const start = vi.mocked(reader.article).mock.calls.length;
    await collectPublisher(reader, { commitProgress }, 'batch'+batch, { ...source, cursor },
      new Date(cutoff.getTime() + batch * 3600000));
    const urls = vi.mocked(reader.article).mock.calls.slice(start).map(call => call[0]);
    expect(urls).toHaveLength(2);
    if (batch === 2) expect(urls[0]).toBe(page.url+'-1');
    if (batch === 5) expect(urls[0]).toBe(page.url+'-2');
    cursor = primaryCursorSchema.parse(commitProgress.mock.calls.at(-1)?.[3]);
  }
});
it('migrates old completed IDs into cross-cutoff progress', async () => {
  vi.mocked(reader.index).mockResolvedValue(['done', 'new'].map(id => ({ id, url: page.url, title: null, publishedAt: cutoff })));
  await collectPublisher(reader, { commitProgress }, 'batch', { ...source, maxArticles: 1,
    cursor: { ...source.cursor, cutoff: new Date(cutoff.getTime() - 3600000).toISOString(), completedIds: ['done'] } }, cutoff);
  expect(commitProgress.mock.calls.flatMap(call => call[2]).map(item => item.externalId)).toEqual(['new']);
});

it('collects full crawl body with stable GUID and actual publication, then completes source', async () => {
  expect(await collectPublisher(reader, { commitProgress }, 'batch', source, cutoff)).toBe(1);
  expect(commitProgress.mock.calls.flatMap(call => call[2])[0]).toMatchObject({ externalId: 'guid1', publishedAt: new Date('2026-09-30T12:00:00Z'),
    metadata: { connectorKind: 'feed', publisher: 'Publisher', publicationKnown: true } });
  expect(JSON.stringify(commitProgress.mock.calls.flatMap(call => call[2]))).not.toContain('"primary":true');
  expect(commitProgress.mock.calls[0]?.[4]).toBe(false);
  expect(commitProgress.mock.calls.at(-1)?.[4]).toBe(true);
});
it('enforces the initial 48h window and excludes future items', async () => {
  vi.mocked(reader.index).mockResolvedValue([
    { id: 'old', url: page.url, title: null, publishedAt: new Date('2026-09-28T00:00:00Z') },
    { id: 'future', url: page.url, title: null, publishedAt: new Date('2026-10-02T00:00:00Z') },
  ]);
  expect(await collectPublisher(reader, { commitProgress }, 'batch', source, cutoff)).toBe(0);
  expect(reader.article).not.toHaveBeenCalled();
});
it('skips unknown publication by default, optional collect_once retains null not today', async () => {
  vi.mocked(reader.index).mockResolvedValue([{ id: 'unknown', url: page.url, title: null, publishedAt: null }]);
  expect(await collectPublisher(reader, { commitProgress }, 'batch', source, cutoff)).toBe(0);
  expect(commitProgress.mock.calls[0]?.[2]).toEqual([]);
  commitProgress.mockClear();
  expect(await collectPublisher(reader, { commitProgress }, 'batch', { ...source, unknownPublication: 'collect_once' }, cutoff)).toBe(1);
  expect(commitProgress.mock.calls.flatMap(call => call[2])[0]).toMatchObject({ publishedAt: null,
    metadata: { publicationKnown: false, publishedAt: null, publicationBasis: 'unknown_collect_once' } });
});
it('resume does not replay successful items or exceed per-source article budget', async () => {
  vi.mocked(reader.index).mockResolvedValue([
    { id: 'done', url: page.url, title: null, publishedAt: cutoff },
    { id: 'new', url: page.url, title: null, publishedAt: cutoff },
    { id: 'another', url: page.url, title: null, publishedAt: cutoff },
  ]);
  const resumed = { ...source, cursor: { ...source.cursor, cutoff: cutoff.toISOString(), completedIds: ['done'] } };
  expect(await collectPublisher(reader, { commitProgress }, 'batch', resumed, cutoff)).toBe(1);
  expect(reader.article).toHaveBeenCalledTimes(1);
});
it('preserves committed successes when a later article fails and does not complete source', async () => {
  vi.mocked(reader.index).mockResolvedValue([
    { id: 'ok', url: page.url, title: null, publishedAt: cutoff },
    { id: 'restricted', url: page.url, title: null, publishedAt: cutoff },
  ]);
  vi.mocked(reader.article).mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, access: 'restricted', content: null });
  await expect(collectPublisher(reader, { commitProgress }, 'batch', source, cutoff)).rejects.toThrow('publisher_article_failed');
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toHaveLength(1);
  expect(commitProgress.mock.calls.every(call => call[4] === false)).toBe(true);
  expect(commitProgress.mock.calls.at(-1)?.[3].attemptedIds).toHaveLength(2);
});
it('does not checkpoint an item whose persistence failed when a later item commits', async () => {
  vi.mocked(reader.index).mockResolvedValue([
    { id: 'rollback', url: page.url, title: null, publishedAt: cutoff },
    { id: 'saved', url: page.url, title: null, publishedAt: cutoff },
  ]);
  const normalCommit = commitProgress.getMockImplementation();
  if (!normalCommit) throw new Error('missing_commit_mock');
  commitProgress.mockImplementation(async (_batch, _source, items: readonly { externalId: string }[]) => {
    if (items.some(item => item.externalId === 'rollback')) throw new Error('synthetic transaction failure');
    return items.length;
  });
  try {
    await expect(collectPublisher(reader, { commitProgress }, 'batch', source, cutoff)).rejects.toThrow('publisher_article_failed');
    expect(commitProgress.mock.calls.at(-1)?.[3].completedIds).toEqual(['saved']);
    expect(commitProgress.mock.calls.at(-1)?.[3].attemptedIds).toEqual(['rollback', 'saved']);
  } finally { commitProgress.mockImplementation(normalCommit); }
});
it('rejects article redirects to a same-host index outside the configured article path', async () => {
  vi.mocked(reader.article).mockResolvedValue({ ...page, canonicalUrl: 'https://example.org/' });
  await expect(collectPublisher(reader, { commitProgress }, 'batch', source, cutoff)).rejects.toThrow('publisher_article_failed');
  expect(commitProgress.mock.calls.flatMap(call => call[2])).toEqual([]);
  expect(commitProgress.mock.calls.every(call => call[4] === false)).toBe(true);
});
it('does not recrawl an unknown collect_once item on subsequent batches', async () => {
  vi.mocked(reader.index).mockResolvedValue([{ id: 'unknown', url: page.url, title: null, publishedAt: null }]);
  expect(await collectPublisher(reader, { commitProgress }, 'batch', { ...source,
    unknownPublication: 'collect_once', cursor: { ...source.cursor, unknownIds: ['unknown'] } }, cutoff)).toBe(0);
  expect(reader.article).not.toHaveBeenCalled();
});
