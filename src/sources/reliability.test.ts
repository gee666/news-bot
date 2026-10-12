import { beforeEach, expect, it, vi } from 'vitest';
import { collectPublisher, type PrimaryReader, type PrimaryStore } from './collector.js';
import { primaryCursorSchema, primarySourceInput, type PrimaryCursor, type PrimarySource } from './config.js';
import type { SourceCollectedItem } from './types.js';
import type { PublisherEntry } from './feed.js';

const cutoff = new Date('2026-10-01T12:00:00Z');
const source: PrimarySource = { id: '11111111-1111-4111-8111-111111111111', cursor: {},
  ...primarySourceInput.parse({ kind: 'feed', name: 'Publisher', publisher: 'Publisher',
    url: 'https://example.org/feed', articlePathPrefixes: ['/news/'], maxArticles: 2 }) };
function entry(id: string, ageHours = 1): PublisherEntry {
  return { id, url: 'https://example.org/news/'+id, title: id,
    publishedAt: new Date(cutoff.getTime() - ageHours * 3600000) };
}
let cursor: PrimaryCursor;
let collected: SourceCollectedItem[];
const commit = vi.fn<PrimaryStore['commitProgress']>(async (_batch, _source, items, next) => {
  cursor = primaryCursorSchema.parse(next);
  collected.push(...items);
  return items.length;
});
const reader: PrimaryReader = { index: vi.fn(), article: vi.fn() };
const run = (hours: number, config: Partial<PrimarySource> = {}, limit?: number) => collectPublisher(reader,
  { commitProgress: commit }, 'batch'+hours, { ...source, ...config, cursor },
  new Date(cutoff.getTime() + hours * 3600000), 48, limit);
beforeEach(() => {
  vi.clearAllMocks();
  cursor = primaryCursorSchema.parse({});
  collected = [];
  vi.mocked(reader.index).mockResolvedValue([]);
  vi.mocked(reader.article).mockImplementation(async url => ({ url, canonicalUrl: url, title: null,
    content: 'Article body', access: 'public', metadata: { status: 200 } }));
});

it('persists a rotating feed before reads and drains discoveries removed from the next snapshot', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('one', 3), entry('two', 2), entry('three', 1)]);
  vi.mocked(reader.article).mockImplementation(async url => {
    expect(cursor.backlog.map(item => item.id)).toContain('three');
    expect(cursor.attemptedIds).toContain(url.split('/').at(-1));
    return { url, canonicalUrl: url, title: null, content: 'Body', access: 'public', metadata: {} };
  });
  expect(await run(0)).toBe(2);
  vi.mocked(reader.index).mockResolvedValue([entry('four', 0)]);
  expect(await run(1)).toBe(2);
  expect(collected.map(item => item.externalId)).toEqual(['one', 'two', 'three', 'four']);
});

it('old blocked articles cannot consume the next cutoff ahead of fresh arrivals', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('blocked', 3), entry('also-blocked', 2)]);
  vi.mocked(reader.article).mockImplementation(async url => ({ url, canonicalUrl: url, title: null,
    content: null, access: 'restricted', metadata: { status: 403 } }));
  await expect(run(0)).rejects.toMatchObject({ code: 'primary_article_restricted_http_403' });
  expect(cursor.attemptedIds).toHaveLength(2);
  expect(cursor.backlog.every(item => item.lastErrorCode === 'primary_article_restricted_http_403')).toBe(true);
  vi.mocked(reader.index).mockResolvedValue([entry('new-one', 0), entry('new-two', 0)]);
  vi.mocked(reader.article).mockImplementation(async url => ({ url, canonicalUrl: url, title: null,
    content: 'Readable', access: 'public', metadata: {} }));
  await expect(run(4)).rejects.toMatchObject({ code: 'primary_article_retry_deferred' });
  expect(collected.map(item => item.externalId)).toEqual(['new-one', 'new-two']);
  expect(vi.mocked(reader.article).mock.calls.slice(2).map(call => call[0])).toEqual([
    entry('new-one').url, entry('new-two').url,
  ]);
});

it('failed attempts exhaust the same-cutoff budget and use configurable bounded exponential retry delays', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('blocked')]);
  vi.mocked(reader.article).mockRejectedValue(new Error('upstream failure'));
  await expect(run(0, { maxArticles: 1, retryDelayMinutes: 30 })).rejects.toThrow('publisher_article_failed');
  expect(cursor.backlog[0]?.nextAttemptAt).toBe('2026-10-01T12:30:00.000Z');
  await expect(run(0, { maxArticles: 1, retryDelayMinutes: 30 })).rejects.toMatchObject({ code: 'primary_article_retry_deferred' });
  expect(reader.article).toHaveBeenCalledTimes(1);
  await expect(run(1, { maxArticles: 1, retryDelayMinutes: 30 })).rejects.toThrow('publisher_article_failed');
  expect(cursor.backlog[0]?.nextAttemptAt).toBe('2026-10-01T14:00:00.000Z');
  expect(cursor.backlog[0]?.failures).toBe(2);
  await expect(run(1.5, { maxArticles: 1, retryDelayMinutes: 30 })).rejects.toMatchObject({ code: 'primary_article_retry_deferred' });
  expect(reader.article).toHaveBeenCalledTimes(2);
  const blocked = cursor.backlog[0];
  if (!blocked) throw new Error('missing_backlog_entry');
  cursor.backlog[0] = { ...blocked, failures: 10 };
  await expect(run(2, { maxArticles: 1, retryDelayMinutes: 30 })).rejects.toThrow('publisher_article_failed');
  expect(cursor.backlog[0]?.nextAttemptAt).toBe('2026-10-02T02:00:00.000Z');
});

it('drains a saved backlog during an index outage without hiding the index failure', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('one', 2), entry('two', 1)]);
  expect(await run(0, { maxArticles: 1 })).toBe(1);
  vi.mocked(reader.index).mockRejectedValue(new Error('index outage'));
  await expect(run(1, { maxArticles: 1 })).rejects.toMatchObject({ code: 'primary_index_failed' });
  expect(collected.map(item => item.externalId)).toEqual(['one', 'two']);
  expect(commit.mock.calls.at(-1)?.[4]).toBe(false);
});

it('bounds overflow, expiry and explicit caller caps', async () => {
  vi.mocked(reader.index).mockResolvedValue(Array.from({ length: 8 }, (_, index) => entry('id'+index, index)));
  expect(await run(0, { maxArticles: 50, backlogLimit: 3 }, 1)).toBe(1);
  expect(cursor.backlog.map(item => item.id)).toEqual(['id0', 'id1', 'id2']);
  expect(cursor.backlogOverflow).toBe(5);
  expect(reader.article).toHaveBeenCalledTimes(1);
  vi.mocked(reader.index).mockResolvedValue([]);
  expect(await run(49, { maxArticles: 50, backlogLimit: 3 })).toBe(0);
  expect(cursor.backlog).toEqual([]);
  expect(reader.article).toHaveBeenCalledTimes(1);
});

it('revalidates saved URLs against narrowed article policy before reading', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('one'), entry('two')]);
  await run(0, { maxArticles: 1 });
  vi.mocked(reader.index).mockResolvedValue([]);
  expect(await run(1, { articlePathPrefixes: ['/other/'] })).toBe(0);
  expect(reader.article).toHaveBeenCalledTimes(1);
  expect(cursor.backlog).toEqual([]);
});

it('recovers skipped undated discoveries after a policy change even when they leave the index', async () => {
  vi.mocked(reader.index).mockResolvedValue([{ ...entry('undated'), publishedAt: null }]);
  expect(await run(0)).toBe(0);
  expect(cursor.unknownIds).toEqual([]);
  expect(cursor.skippedUnknownIds).toEqual(['undated']);
  vi.mocked(reader.index).mockResolvedValue([]);
  expect(await run(1, { unknownPublication: 'collect_once' })).toBe(1);
  expect(collected[0]).toMatchObject({ publishedAt: null, metadata: { publicationKnown: false } });
  expect(await run(2, { unknownPublication: 'collect_once' })).toBe(0);
  expect(reader.article).toHaveBeenCalledTimes(2);
});

it('a failed edit reservation resets the cadence so inaccessible known pages cannot monopolize one-slot sources', async () => {
  cursor = primaryCursorSchema.parse({ cutoff: cutoff.toISOString(), unseenBatches: 2,
    seen: ['known-one', 'known-two'].map(id => ({ id, checkedAt: '2026-10-01T09:00:00.000Z' })) });
  vi.mocked(reader.index).mockResolvedValue([entry('known-one'), entry('known-two'), entry('fresh')]);
  vi.mocked(reader.article).mockRejectedValueOnce(new Error('known article now restricted'));
  await expect(run(0, { maxArticles: 1 })).rejects.toThrow('publisher_article_failed');
  expect(vi.mocked(reader.article).mock.calls[0]?.[0]).toBe(entry('known-one').url);
  await expect(run(4, { maxArticles: 1 })).rejects.toMatchObject({ code: 'primary_article_retry_deferred' });
  expect(vi.mocked(reader.article).mock.calls[1]?.[0]).toBe(entry('fresh').url);
  expect(collected.map(item => item.externalId)).toEqual(['fresh']);
});

it('schedules undated discoveries by discovery age rather than GUID lexical order', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('first', 2), { ...entry('z-old'), publishedAt: null }]);
  await run(0, { maxArticles: 1, unknownPublication: 'collect_once' });
  vi.mocked(reader.index).mockResolvedValue([{ ...entry('a-new'), publishedAt: null }]);
  await run(1, { maxArticles: 1, unknownPublication: 'collect_once' });
  expect(collected.map(item => item.externalId)).toEqual(['first', 'z-old']);
});

it('applies submission-date semantics to unprocessed discoveries saved under the former feed date role', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('first', 2), entry('pending')]);
  await run(0, { maxArticles: 1 });
  vi.mocked(reader.index).mockResolvedValue([]);
  await run(1, { maxArticles: 1, feedDateRole: 'submission', unknownPublication: 'collect_once' });
  expect(collected[1]).toMatchObject({ externalId: 'pending', publishedAt: null,
    metadata: { submittedAt: '2026-10-01T11:00:00.000Z', publicationKnown: false } });
});

it('does not read anything if discovery or attempt reservation cannot be persisted', async () => {
  vi.mocked(reader.index).mockResolvedValue([entry('one')]);
  commit.mockRejectedValueOnce(new Error('database down'));
  await expect(run(0)).rejects.toMatchObject({ code: 'primary_store_failed' });
  expect(reader.article).not.toHaveBeenCalled();
  commit.mockImplementationOnce(async (_batch, _source, _items, next) => {
    cursor = primaryCursorSchema.parse(next); return 0;
  }).mockRejectedValueOnce(new Error('reservation failed'));
  await expect(run(0)).rejects.toMatchObject({ code: 'primary_store_failed' });
  expect(reader.article).not.toHaveBeenCalled();
});

it.each([NaN, -1, 1.5])('rejects an invalid explicit budget %s before I/O', async limit => {
  await expect(run(0, {}, limit)).rejects.toThrow('invalid_article_budget');
  expect(reader.index).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
});
