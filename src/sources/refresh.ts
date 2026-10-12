import { z } from 'zod';
import { db } from '../db.js';
import { publicUrl } from '../pipeline/research-fetch.js';
import { publisherReader } from './collector.js';
import { publisherArticle } from './config.js';
import { publisherRefreshState } from './refresh-state.js';
import { PostgresSourceCollectionStore } from './collection-store.js';
import { normalizeText } from './content.js';
import { extractMarkdownLinks } from './markdown.js';

/** Internal operator API, not a scheduler or HTTP route. Caller must hold news-bot-pipeline lease. */
export async function refreshPublisherItem(itemId: string, batchId: string):
Promise<{ itemId: string; revisionId: string; changed: boolean }> {
  z.uuid().parse(itemId); z.uuid().parse(batchId);
  const state = await publisherRefreshState(db, itemId, batchId);
  const page = await publisherReader.article(state.url);
  const expectedCanonical = typeof state.item.metadata.canonicalUrl === 'string'
    ? publicUrl(state.item.metadata.canonicalUrl).href : state.url;
  if (page.access !== 'public' || !page.content || !page.canonicalUrl
    || publicUrl(page.url).href !== state.url || publicUrl(page.canonicalUrl).href !== expectedCanonical
    || !publisherArticle(page.canonicalUrl, state.source)) throw new Error('publisher_refresh_invalid_result');
  const text = normalizeText(page.title ? '# '+page.title+'\n\n'+page.content : page.content);
  return new PostgresSourceCollectionStore().commitPublisherRefresh(batchId, itemId, state.fingerprint, {
    externalId: state.item.external_id, originalUrl: state.item.original_url, originalText: text, normalizedText: text,
    publishedAt: state.item.published_at === null ? null : new Date(state.item.published_at), editedAt: null,
    links: extractMarkdownLinks(text, page.canonicalUrl),
    metadata: { ...state.item.metadata, title: page.title, byline: page.metadata.byline ?? null,
      cleaning: page.metadata.cleaning ?? null, canonicalUrl: page.canonicalUrl },
  });
}
