import { cleanSourceUrl } from '../source-url.js';
import { cleanArticle } from '../sources/article.js';
import { readFailure, usefulSourceTitle } from '../sources/read-quality.js';
import { publicUrl, ResearchFetchError } from './research-fetch.js';
import { fetchCrawlerPage } from './crawler-client.js';
import { readHttp } from './research-http.js';
import { readArxiv } from './research-arxiv.js';
export { searchPages } from './research-search.js';

export interface ResearchPage {
  url: string;
  canonicalUrl: string | null;
  title: string | null;
  content: string | null;
  access: 'public' | 'restricted' | 'unavailable' | 'unknown';
  publishedAt?: string | null;
  updatedAt?: string | null;
  fetchedAt?: string;
  metadata: {
    media?: Array<{ type: 'image' | 'video'; url: string }>;
    status?: number; error?: string; truncated?: boolean;
    method?: 'crawl4ai' | 'http'; contentFormat?: 'markdown' | 'html' | 'text' | 'json';
    publishedAt?: string | null; updatedAt?: string | null; fetchedAt?: string;
    crawlerError?: string; cleaning?: 'readability' | 'social_post' | 'arxiv_abstract' | 'arxiv_full_text'; byline?: string | null;
    followupLinks?: { url: string; title: string }[];
    paper?: { id: string; version: string | null; extent: 'abstract' | 'full_text' };
    readUrl?: string; representationReads?: number; fullTextError?: string; abstractFallbackSkipped?: 'page_budget';
  };
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (original: string, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    const key = entity.toLowerCase();
    if (key in named) return named[key] ?? original;
    const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
      ? String.fromCodePoint(code) : ' ';
  });
}

export function htmlText(html: string): { title: string | null; content: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(html);
  const cleaned = html.replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<\/?(?:a|b|strong|i|em|span|code|sup|sub|u|small|abbr)\b[^>]*>/giu, '')
    .replace(/<[^>]*>/gu, ' ');
  return { title: titleMatch?.[1] ? decodeEntities(titleMatch[1].replace(/<[^>]*>/gu, ' ')).trim().slice(0, 500) : null,
    content: decodeEntities(cleaned).replace(/\s+/gu, ' ').trim() };
}

function explicitDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)
    ? null : date.toISOString();
}

function publisherDates(html: string): { publishedAt: string | null; updatedAt: string | null } {
  // Only document-head metadata identifies this page, not dates in related cards.
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu.exec(html)?.[1] ?? '';
  const dates = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = new Map<string, string>();
    for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      attributes.set(match[1]!.toLowerCase(), decodeEntities(match[2] ?? match[3] ?? ''));
    }
    const name = attributes.get('property') ?? attributes.get('name');
    if (name && attributes.has('content')) dates.set(name.toLowerCase(), attributes.get('content')!);
  }
  return { publishedAt: explicitDate(dates.get('article:published_time')),
    updatedAt: explicitDate(dates.get('article:modified_time')) };
}

function transientCrawlerFailure(page: ResearchPage): boolean {
  if (page.access !== 'unavailable') return false;
  const status = page.metadata.status;
  if (status !== undefined && status >= 200 && status < 300
    && /^crawler_(?:render_failed|empty_content|article_unavailable)$/u.test(page.metadata.error ?? '')) return true;
  if (status !== undefined && status !== 429 && status < 500) return false;
  return /^(?:crawler_(?:not_configured|invalid_endpoint|timeout|failed|invalid_response|render_failed|empty_content|article_unavailable)|crawler_http_(?:408|429|5\d\d))$/u
    .test(page.metadata.error ?? '');
}

export async function fetchPage(url: string, maxRepresentations: 1 | 2 = 2): Promise<ResearchPage> {
  try { publicUrl(url); } catch (error) {
    if (error instanceof ResearchFetchError) return fetchReadPage(url);
    throw error;
  }
  return await readArxiv(url, fetchReadPage, maxRepresentations) ?? fetchReadPage(url);
}

async function fetchReadPage(url: string): Promise<ResearchPage> {
  let fetchedAt = new Date().toISOString();
  const metadata: ResearchPage['metadata'] = { fetchedAt };
  try {
    const target = publicUrl(cleanSourceUrl(url));
    const readUrl = target.href;
    if (process.env.RESEARCH_CRAWLER_URL && process.env.RESEARCH_CRAWLER_API_TOKEN) {
      const page = await fetchCrawlerPage(readUrl, 'article');
      fetchedAt = new Date().toISOString();
      metadata.fetchedAt = fetchedAt;
      if (!transientCrawlerFailure(page)) {
        return { ...page, url, fetchedAt, metadata: { ...page.metadata, method: 'crawl4ai', contentFormat: 'markdown',
          publishedAt: page.publishedAt ?? null, updatedAt: page.updatedAt ?? null, fetchedAt } };
      }
      if (page.metadata.error) metadata.crawlerError = page.metadata.error;
    }
    metadata.method = 'http';
    const response = await readHttp(readUrl);
    fetchedAt = new Date().toISOString();
    metadata.fetchedAt = fetchedAt;
    metadata.status = response.status;
    if (response.status < 200 || response.status >= 300) {
      return { url, canonicalUrl: cleanSourceUrl(response.url), title: null, content: null,
        access: [401, 403].includes(response.status) ? 'restricted' : 'unavailable',
        fetchedAt, metadata };
    }
    const html = ['text/html', 'application/xhtml+xml'].includes(response.contentType);
    const parsed = html ? htmlText(response.text) : { title: null, content: response.text.trim() };
    metadata.contentFormat = html ? 'html' : response.contentType === 'application/json' ? 'json' : 'text';
    const failure = readFailure(parsed.title, parsed.content, response.url);
    if (failure) {
      return { url, canonicalUrl: cleanSourceUrl(response.url), title: null, content: null, access: failure, fetchedAt,
        metadata: { ...metadata, error: failure === 'restricted' ? 'restricted_challenge' : 'page_load_error' } };
    }
    const article = html ? cleanArticle(response.text, response.url) : null;
    if (html && !article) return { url, canonicalUrl: cleanSourceUrl(response.url), title: parsed.title, content: null,
      access: 'unavailable', fetchedAt, metadata: { ...metadata, error: 'article_unavailable' } };
    const content = article?.content ?? parsed.content;
    const dates = html ? publisherDates(response.text) : { publishedAt: null, updatedAt: null };
    if (!dates.publishedAt && article?.publishedAt) dates.publishedAt = explicitDate(article.publishedAt);
    if (article) {
      metadata.media = article.media ?? [];
      metadata.contentFormat = 'markdown'; metadata.cleaning = article.cleaning ?? 'readability'; metadata.byline = article.byline;
      if (article.followupLinks) metadata.followupLinks = article.followupLinks;
      if (article.paper) metadata.paper = article.paper;
    }
    return { url, canonicalUrl: cleanSourceUrl(response.url), title: usefulSourceTitle(article?.title ?? parsed.title, content, response.url),
      content: content || null,
      access: content ? 'public' : 'unavailable',
      ...dates, fetchedAt, metadata: { ...metadata, ...dates } };
  } catch (error) {
    if (!(error instanceof ResearchFetchError)) throw error;
    fetchedAt = new Date().toISOString();
    metadata.fetchedAt = fetchedAt;
    return { url, canonicalUrl: null, title: null, content: null, access: 'unavailable', fetchedAt,
      metadata: { ...metadata, error: error.code } };
  }
}

