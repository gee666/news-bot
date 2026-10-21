import { validatedMedia } from './media.js';
import { primaryCursorSchema, publisherArticle, type PrimaryCursor, type PrimarySource,
  type PublisherBacklogEntry } from './config.js';
import type { PublisherEntry } from './feed.js';

export function publisherProgress(input: PrimarySource['cursor'], cutoff: Date,
  policy: PrimarySource['unknownPublication'] = 'skip'): PrimaryCursor {
  const previous = primaryCursorSchema.parse(input);
  const sameBatch = previous.cutoff !== null && Date.parse(previous.cutoff) === cutoff.getTime();
  // Legacy skip cursors mixed skipped pages with successful undated reads.
  if (previous.unknownPolicy === null && policy === 'skip') {
    previous.skippedUnknownIds = [...new Set([...previous.skippedUnknownIds, ...previous.unknownIds])].slice(-1000);
    previous.unknownIds = [];
  }
  const recovering = policy === 'collect_once' && previous.unknownPolicy === 'skip';
  const skipped = new Set(recovering ? previous.skippedUnknownIds : []);
  const seen = new Map(previous.seen.filter(item => !skipped.has(item.id)).map(item => [item.id, item]));
  if (previous.cutoff) for (const id of previous.completedIds) {
    if (!seen.has(id) && !skipped.has(id)) seen.set(id, { id, checkedAt: previous.cutoff });
  }
  return { ...previous, cutoff: cutoff.toISOString(), unknownPolicy: policy,
    completedIds: sameBatch ? previous.completedIds.filter(id => !skipped.has(id)) : [],
    attemptedIds: sameBatch ? [...new Set([...previous.attemptedIds, ...previous.completedIds])] : [],
    skippedUnknownIds: recovering ? [] : [...previous.skippedUnknownIds],
    seen: [...seen.values()].slice(-1000), rechecked: sameBatch && previous.rechecked,
    unseenBatches: !sameBatch && (previous.attemptedIds.length || previous.completedIds.length)
      ? previous.rechecked ? 0 : Math.min(2, previous.unseenBatches + 1) : previous.unseenBatches };
}

/** Keep rotating-index discoveries until their collection window expires. */
export function discoverPublisherEntries(cursor: PrimaryCursor, index: PublisherEntry[], source: PrimarySource,
  cutoff: Date, since: number): PublisherEntry[] {
  const eligible = (entry: PublisherBacklogEntry) => publisherArticle(entry.url, source) === entry.url
    && Date.parse(entry.discoveredAt) <= cutoff.getTime()
    && (entry.publishedAt ? Date.parse(entry.publishedAt) >= since && Date.parse(entry.publishedAt) <= cutoff.getTime()
      : Date.parse(entry.discoveredAt) >= since);
  const backlog = new Map(cursor.backlog.filter(eligible).map(entry => [entry.id, entry]));
  for (const entry of index) {
    if (publisherArticle(entry.url, source) !== entry.url || !entry.id.length || entry.id.length > 4096
      || (entry.publishedAt && (!Number.isFinite(entry.publishedAt.getTime())
        || entry.publishedAt.getTime() < since || entry.publishedAt > cutoff))) continue;
    const previous = backlog.get(entry.id);
    backlog.set(entry.id, { id: entry.id, url: entry.url, title: entry.title?.slice(0, 500) ?? null,
      publishedAt: entry.publishedAt?.toISOString() ?? null,
      media: validatedMedia(entry.media ?? previous?.media, entry.url),
      discoveredAt: previous?.discoveredAt ?? cutoff.toISOString(), failures: previous?.failures ?? 0,
      nextAttemptAt: previous?.nextAttemptAt ?? null, lastErrorCode: previous?.lastErrorCode ?? null });
  }
  const seen = new Set(cursor.seen.map(item => item.id));
  const skipped = new Set(cursor.skippedUnknownIds);
  const priority = (entry: PublisherBacklogEntry) => skipped.has(entry.id) ? 3
    : entry.failures ? 1 : seen.has(entry.id) ? 2 : 0;
  // On overflow, protect unattempted discoveries before retries and edit checks.
  // Within each class keep the freshest entries rather than pinning the oldest failures.
  const retained = [...backlog.values()].sort((a, b) => priority(a) - priority(b)
    || (b.publishedAt ?? b.discoveredAt).localeCompare(a.publishedAt ?? a.discoveredAt) || a.id.localeCompare(b.id));
  const limit = source.backlogLimit ?? 200;
  cursor.backlogOverflow = Math.min(1_000_000_000, cursor.backlogOverflow + Math.max(0, retained.length - limit));
  cursor.backlog = retained.slice(0, limit);
  const ids = new Set(cursor.backlog.map(entry => entry.id));
  cursor.seen = cursor.seen.filter(item => ids.has(item.id));
  cursor.skippedUnknownIds = cursor.skippedUnknownIds.filter(id => ids.has(id));
  return cursor.backlog.filter(entry => !cursor.completedIds.includes(entry.id)
    && !cursor.attemptedIds.includes(entry.id)
    && !(entry.nextAttemptAt && Date.parse(entry.nextAttemptAt) > cutoff.getTime())
    && !((!entry.publishedAt || source.feedDateRole === 'submission') && (cursor.unknownIds.includes(entry.id)
      || (source.unknownPublication === 'skip' && cursor.skippedUnknownIds.includes(entry.id)))))
    .map(entry => ({ id: entry.id, url: entry.url, title: entry.title, media: validatedMedia(entry.media, entry.url),
      publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : null }));
}

/** Fresh discoveries precede retries. Edit checks still get one slot every third backlog batch. */
export function selectPublisherEntries(entries: PublisherEntry[], cursor: PrimaryCursor, budget: number): PublisherEntry[] {
  const remaining = Math.max(0, budget - cursor.attemptedIds.length);
  const seen = new Map(cursor.seen.map(item => [item.id, item.checkedAt]));
  const backlog = new Map(cursor.backlog.map(item => [item.id, item]));
  const fresh = entries.filter(entry => !seen.has(entry.id) && !backlog.get(entry.id)?.failures).sort((a, b) =>
    (a.publishedAt?.getTime() ?? Date.parse(backlog.get(a.id)?.discoveredAt ?? ''))
      - (b.publishedAt?.getTime() ?? Date.parse(backlog.get(b.id)?.discoveredAt ?? '')) || a.id.localeCompare(b.id));
  const retries = entries.filter(entry => backlog.get(entry.id)?.failures).sort((a, b) =>
    (backlog.get(a.id)?.nextAttemptAt ?? '').localeCompare(backlog.get(b.id)?.nextAttemptAt ?? '') || a.id.localeCompare(b.id));
  const known = entries.filter(entry => seen.has(entry.id) && !backlog.get(entry.id)?.failures).sort((a, b) =>
    (seen.get(a.id) ?? '').localeCompare(seen.get(b.id) ?? '') || a.id.localeCompare(b.id));
  if (remaining && fresh.length && known.length && cursor.unseenBatches === 2 && !cursor.rechecked) {
    return [...known.slice(0, 1), ...fresh, ...retries].slice(0, remaining);
  }
  return [...fresh, ...retries, ...known].slice(0, remaining);
}

/** Reserve the attempt durably before the network read, including a conservative crash retry delay. */
export function reservePublisherAttempt(cursor: PrimaryCursor, entry: PublisherEntry, source: PrimarySource): PrimaryCursor {
  return { ...cursor, attemptedIds: [...cursor.attemptedIds, entry.id],
    rechecked: cursor.rechecked || cursor.seen.some(item => item.id === entry.id),
    backlog: cursor.backlog.map(item => item.id !== entry.id ? item : { ...item,
      failures: Math.min(10, item.failures + 1),
      nextAttemptAt: new Date(Date.parse(cursor.cutoff ?? '')
        + Math.min(720, (source.retryDelayMinutes ?? 60) * 2 ** item.failures) * 60000).toISOString() }) };
}
