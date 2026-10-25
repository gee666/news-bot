import { discoverMedia, mergeMedia, validatedMedia } from './media.js';
import type { AppSettings } from '../settings.js';
import { db } from '../db.js';
import { fetchPublic } from '../pipeline/research-fetch.js';
import { fetchCrawlerPage } from '../pipeline/crawler-client.js';
import { fetchPage, type ResearchPage } from '../pipeline/research-page.js';
import { extractMarkdownLinks, normalizeText } from './links.js';
import { PostgresSourceCollectionStore } from './collection-store.js';
import { publisherArticle, type PrimarySource, type PrimaryCursor } from './config.js';
import { parseFeed, publisherDate, type PublisherEntry } from './feed.js';
import { discoverWebsite, articlePublication } from './website.js';
import { preparePrimarySources } from './repository.js';
import { discoverPublisherEntries, publisherProgress, reservePublisherAttempt, selectPublisherEntries } from './progress.js';
import type { SourceCollectedItem } from './types.js';
import { collectionError, feedCollectionError, pageCollectionError, PrimaryCollectionError } from './collector-errors.js';

export interface PrimaryReader {
  index(source: PrimarySource): Promise<PublisherEntry[]>;
  article(url: string): Promise<ResearchPage>;
}
export const publisherReader: PrimaryReader = {
  async index(source) {
    if (source.kind === 'feed') {
      const fetched = await fetchPublic(source.url, { timeoutMs: 15000, maxBytes: 1000000, maxRedirects: 3, allowXml: true });
      const outsidePublisher = new URL(fetched.url).hostname !== new URL(source.url).hostname;
      if (fetched.status !== 200 || outsidePublisher) throw feedCollectionError(fetched.status, outsidePublisher);
      return parseFeed(fetched.text, source);
    }
    const page = await fetchCrawlerPage(source.url, 'index');
    if (page.access !== 'public' || !page.content || !page.canonicalUrl
      || new URL(page.canonicalUrl).hostname !== new URL(source.url).hostname) {
      throw pageCollectionError('index', page, !page.content ? 'empty_content'
        : !page.canonicalUrl ? 'invalid_canonical' : 'outside_publisher');
    }
    return discoverWebsite(page.content, source);
  },
  article: fetchPage,
};
export interface PrimaryStore {
  commitProgress(batchId: string, source: { id: string; configVersion?: number }, items: readonly SourceCollectedItem[],
    cursor: object, completed: boolean): Promise<number>;
}
export async function collectPublisher(reader: PrimaryReader, store: PrimaryStore, batchId: string,
  source: PrimarySource, cutoff: Date, windowHours = 48, entryLimit?: number): Promise<number> {
  if (!Number.isFinite(cutoff.getTime()) || !Number.isFinite(windowHours) || windowHours < 1 || windowHours > 48) {
    throw new Error('invalid_collection_window');
  }
  if (entryLimit !== undefined && (!Number.isInteger(entryLimit) || entryLimit < 0)) throw new Error('invalid_article_budget');
  const since = cutoff.getTime() - windowHours * 3600000;
  let cursor = publisherProgress(source.cursor, cutoff, source.unknownPublication);
  let indexEntries: PublisherEntry[] = [];
  let firstFailure: PrimaryCollectionError | undefined;
  try { indexEntries = await reader.index(source); }
  catch (error) {
    firstFailure = collectionError(error, 'index');
    if (!cursor.backlog.length) throw firstFailure;
  }
  const entries = discoverPublisherEntries(cursor, indexEntries, source, cutoff, since);
  // Save discoveries before any article read. Failed and abandoned batches must not lose a rotating feed.
  try { await store.commitProgress(batchId, source, [], cursor, false); }
  catch (error) { throw collectionError(error, 'store'); }
  let collected = 0;
  for (const entry of selectPublisherEntries(entries, cursor, Math.min(source.maxArticles, entryLimit ?? source.maxArticles))) {
    const reserved = reservePublisherAttempt(cursor, entry, source);
    try { await store.commitProgress(batchId, source, [], reserved, false); }
    catch (error) { throw collectionError(error, 'store'); }
    cursor = reserved;
    let phase: 'article' | 'store' = 'article';
    try {
      const page = await reader.article(entry.url);
      if (page.access !== 'public' || !page.content || !page.canonicalUrl
        || !publisherArticle(page.canonicalUrl, source)) {
        throw pageCollectionError('article', page, !page.content ? 'empty_content'
          : !page.canonicalUrl ? 'invalid_canonical' : 'outside_publisher');
      }
      const articleDate = page.publishedAt ? publisherDate(page.publishedAt) : null;
      if (page.publishedAt && !articleDate) throw new PrimaryCollectionError('invalid_article_date', { phase: 'article', reason: 'invalid_date' });
      const submissionDate = source.kind === 'feed' && source.feedDateRole === 'submission' ? entry.publishedAt : null;
      const publishedAt = articleDate ?? (source.feedDateRole !== 'submission' ? entry.publishedAt : null)
        ?? articlePublication(page.content);
      // A fresh submission is not proof that the linked article was freshly published.
      const eligible = publishedAt ? publishedAt.getTime() >= since && publishedAt <= cutoff
        : source.unknownPublication === 'collect_once';
      const items: SourceCollectedItem[] = [];
      if (eligible) {
        const text = normalizeText(page.title ? '# '+page.title+'\n\n'+page.content : page.content);
        items.push({ externalId: entry.id, originalUrl: entry.url, originalText: text, normalizedText: text,
          publishedAt, editedAt: null, links: extractMarkdownLinks(text, page.canonicalUrl),
          metadata: { connectorKind: source.kind, publisher: source.publisher, title: page.title ?? entry.title,
            byline: page.metadata.byline ?? null, cleaning: page.metadata.cleaning ?? null,
            publicationKnown: publishedAt !== null, publishedAt: publishedAt?.toISOString() ?? null,
            publicationBasis: articleDate ? 'article_metadata'
              : entry.publishedAt && source.feedDateRole !== 'submission' ? source.kind
                : publishedAt ? 'article_front_matter' : 'unknown_collect_once',
            feedEntryPublishedAt: source.kind === 'feed' ? entry.publishedAt?.toISOString() ?? null : null,
            submittedAt: submissionDate?.toISOString() ?? null,
            media: mergeMedia(validatedMedia(entry.media, entry.url), validatedMedia(page.metadata.media, page.canonicalUrl),
              discoverMedia(page.content, page.canonicalUrl, page.metadata.contentFormat === 'html' ? 'html' : 'markdown')),
            canonicalUrl: page.canonicalUrl } });
      }
      const nextCursor: PrimaryCursor = { ...cursor,
        unknownIds: !publishedAt && eligible ? [...new Set([...cursor.unknownIds, entry.id])].slice(-1000) : cursor.unknownIds,
        skippedUnknownIds: !publishedAt && !eligible
          ? [...new Set([...cursor.skippedUnknownIds, entry.id])].slice(-1000) : cursor.skippedUnknownIds,
        backlog: cursor.backlog.map(item => item.id !== entry.id ? item : { ...item, failures: 0, nextAttemptAt: null, lastErrorCode: null }),
        completedIds: [...new Set([...cursor.completedIds, entry.id])].slice(-100),
        rechecked: cursor.rechecked || cursor.seen.some(item => item.id === entry.id),
        seen: [...cursor.seen.filter(item => item.id !== entry.id), { id: entry.id, checkedAt: cutoff.toISOString() }].slice(-1000) };
      phase = 'store';
      collected += await store.commitProgress(batchId, source, items, nextCursor, false);
      cursor = nextCursor;
    } catch (error) {
      const failure = collectionError(error, phase);
      firstFailure ??= failure;
      cursor = { ...cursor, backlog: cursor.backlog.map(item => item.id !== entry.id ? item
        : { ...item, lastErrorCode: failure.code }) };
      // A failed item consumes budget too. Never count a rolled-back item as completed.
      try { await store.commitProgress(batchId, source, [], cursor, false); }
      catch (storeError) { throw collectionError(storeError, 'store'); }
    }
  }
  const deferred = cursor.backlog.some(entry => entry.failures > 0);
  try { collected += await store.commitProgress(batchId, source, [], cursor, !firstFailure && !deferred); }
  catch (error) { throw collectionError(error, 'store'); }
  if (firstFailure) throw new PrimaryCollectionError('publisher_article_failed', firstFailure.diagnostic);
  if (deferred) throw new PrimaryCollectionError('publisher_article_failed', { phase: 'article', reason: 'retry_deferred' });
  return collected;
}
export async function collectPrimarySources(batchId: string, cutoff: Date, settings: AppSettings):
Promise<{ collected: number; failed: number }> {
  const sources = await preparePrimarySources(batchId);
  const store = new PostgresSourceCollectionStore();
  let collected = 0;
  let failed = 0;
  for (const source of sources) {
    try { collected += await collectPublisher(publisherReader, store, batchId, source, cutoff, settings.collectionWindowHours); }
    catch (error) {
      failed++;
      const failure = collectionError(error, 'index');
      console.warn('Primary source collection failed', { batchId, sourceId: source.id,
        code: failure.code, ...failure.diagnostic });
      await db.query(`UPDATE batch_sources SET status='failed',error_code=$3
        WHERE batch_id=$1 AND source_id=$2 AND status <> 'completed'`, [batchId, source.id, failure.code]);
    }
  }
  const total = await db.query<{ collected: number; failed: number }>(`SELECT COUNT(*)::int AS collected,
    (SELECT COUNT(*)::int FROM batch_sources bs JOIN sources source ON source.id=bs.source_id
      WHERE bs.batch_id=$1 AND bs.status='failed' AND source.connector_type IN ('feed','website')) AS failed
    FROM batch_items bi
    JOIN item_revisions r ON r.id=bi.revision_id JOIN source_items i ON i.id=r.item_id
    JOIN sources s ON s.id=i.source_id WHERE bi.batch_id=$1 AND s.connector_type IN ('feed','website')`, [batchId]);
  return { collected: total.rows[0]?.collected ?? collected, failed: total.rows[0]?.failed ?? failed };
}
