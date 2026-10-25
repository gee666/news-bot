import { cleanSourceUrl } from '../source-url.js';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { envInteger, publicUrl, ResearchFetchError, resolvePublicAddress } from './research-fetch.js';
import { cleanArticle } from '../sources/article.js';
import { readFailure, usefulSourceTitle } from '../sources/read-quality.js';
import type { ResearchPage } from './research-page.js';

export interface CrawlerPage extends ResearchPage { publishedAt: string | null }

const resultSchema = z.object({
  url: z.string().max(4096),
  success: z.boolean(),
  status_code: z.number().int().min(100).max(599).nullable().optional(),
  redirected_url: z.string().max(4096).nullable().optional(),
  redirected_status_code: z.number().int().min(100).max(599).nullable().optional(),
  error_message: z.string().nullable().optional(),
  html: z.string().nullable().optional(),
  markdown: z.object({ raw_markdown: z.string() }).nullable().optional(),
  metadata: z.object({
    title: z.string().nullable().optional(),
    'article:published_time': z.string().nullable().optional(),
  }).nullable().optional(),
});
const responseSchema = z.object({ success: z.boolean(), results: z.array(resultSchema).length(1) });

function unavailable(url: string, error: string, status?: number): CrawlerPage {
  return { url, canonicalUrl: null, title: null, content: null, access: 'unavailable',
    publishedAt: null, metadata: { error, ...(status === undefined ? {} : { status }) } };
}

function articleDate(value: string | null | undefined): string | null {
  // Do not interpret arbitrary dates from related cards, page text or updated docs.
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)
    ? null : date.toISOString();
}

async function validateHost(url: URL, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    await Promise.race([resolvePublicAddress(url.hostname.replace(/^\[|\]$/gu, '')),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error('timeout'));
        signal.addEventListener('abort', abort, { once: true });
      })]);
  } finally { signal.removeEventListener('abort', abort); }
}

/** Crawl4AI 0.9.4 owns DNS-pinned egress, including redirects and subresources. */
export async function fetchCrawlerPage(input: string, purpose: 'index' | 'article' = 'index'): Promise<CrawlerPage> {
  const endpoint = process.env.RESEARCH_CRAWLER_URL;
  const token = process.env.RESEARCH_CRAWLER_API_TOKEN;
  if (!endpoint || !token) return unavailable(input, 'crawler_not_configured');
  let service: URL;
  try {
    service = new URL(endpoint);
    if (!['http:', 'https:'].includes(service.protocol) || service.username || service.password
      || service.search || service.hash || !['', '/'].includes(service.pathname)) throw new Error('endpoint');
  } catch { return unavailable(input, 'crawler_invalid_endpoint'); }
  const timeoutMs = envInteger('RESEARCH_CRAWLER_TIMEOUT_MS', 60_000, 120_000);
  const maxBytes = envInteger('RESEARCH_CRAWLER_MAX_BYTES', 5_000_000, 10_000_000);
  const signal = AbortSignal.timeout(timeoutMs);
  const settings = { service, token, maxBytes, purpose };
  let first = await fetchOnce(input, settings, signal);
  const busyRetries = envInteger('RESEARCH_CRAWLER_BUSY_RETRIES', 6, 12);
  const busyDelay = envInteger('RESEARCH_CRAWLER_BUSY_DELAY_MS', 5000, 15_000);
  for (let attempt = 0; first.metadata.error === 'crawler_http_429' && attempt < busyRetries; attempt++) {
    try { await delay(busyDelay, undefined, { signal }); }
    catch { return unavailable(input, 'crawler_timeout'); }
    first = await fetchOnce(input, settings, signal);
  }
  const renderRetries = envInteger('RESEARCH_CRAWLER_RENDER_RETRIES', 2, 3);
  for (let attempt = 0; first.metadata.error === 'crawler_render_failed' && attempt < renderRetries; attempt++) {
    try {
      await delay(1000, undefined, { signal });
      first = await fetchOnce(input, settings, signal);
    } catch { return unavailable(input, signal.aborted ? 'crawler_timeout' : 'crawler_failed'); }
  }
  return first;
}

interface CrawlerSettings { service: URL; token: string; maxBytes: number; purpose: 'index' | 'article' }

async function fetchOnce(input: string, settings: CrawlerSettings, signal: AbortSignal): Promise<CrawlerPage> {
  const { service, token, maxBytes } = settings;
  try {
    signal.throwIfAborted();
    const target = publicUrl(cleanSourceUrl(input));
    // The service independently revalidates and pins at connect time.
    await validateHost(target, signal);
    const response = await fetch(new URL('/crawl', service), {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ urls: [target.href],
        browser_config: { type: 'BrowserConfig', params: {
          headless: true, java_script_enabled: true, text_mode: false,
        } },
        crawler_config: { type: 'CrawlerRunConfig', params: {
          cache_mode: { type: 'CacheMode', params: 'disabled' },
          word_count_threshold: 1, excluded_tags: ['nav', 'footer', 'aside'],
          wait_until: 'domcontentloaded', page_timeout: 30_000,
          delay_before_return_html: 3, scan_full_page: true, max_scroll_steps: 5, scroll_delay: 0.3,
        } },
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable(input, `crawler_http_${response.status}`);
    }
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      await response.body?.cancel();
      return unavailable(input, 'crawler_invalid_response');
    }
    if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
      await response.body?.cancel();
      return unavailable(input, 'crawler_response_too_large');
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader) return unavailable(input, 'crawler_invalid_response');
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) return unavailable(input, 'crawler_response_too_large');
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const parsed = responseSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!parsed.success) return unavailable(input, 'crawler_invalid_response');
    const result = parsed.data.results[0];
    if (!result || !parsed.data.success) return unavailable(input, 'crawler_failed');
    const status = result.redirected_status_code ?? result.status_code;
    if (cleanSourceUrl(publicUrl(result.url).href) !== target.href) return unavailable(input, 'crawler_result_mismatch');
    const canonicalUrl = cleanSourceUrl(publicUrl(result.redirected_url || result.url).href);
    await validateHost(new URL(canonicalUrl), signal);
    const title = result.metadata?.title?.trim().slice(0, 500) || null;
    const markdown = result.markdown?.raw_markdown.trim() ?? '';
    const failure = readFailure(title, markdown, canonicalUrl);
    if (status === 401 || status === 403 || failure === 'restricted'
      || /blocked by anti-bot protection/iu.test(result.error_message ?? '')) {
      return { ...unavailable(input, 'crawler_restricted', status ?? undefined), canonicalUrl, access: 'restricted' };
    }
    if (!result.success || status === undefined || status === null || status < 200 || status >= 300) {
      return unavailable(input, 'crawler_failed', status ?? undefined);
    }
    if (failure === 'unavailable') {
      return unavailable(input, status === 200 ? 'crawler_render_failed' : 'crawler_failed', status);
    }
    if (!markdown) return unavailable(input, 'crawler_empty_content', status);
    const article = settings.purpose === 'article' ? cleanArticle(result.html ?? '', canonicalUrl) : null;
    if (settings.purpose === 'article' && !article) return unavailable(input, 'crawler_article_unavailable', status);
    const content = article?.content ?? markdown;
    const articleFailure = readFailure(article?.title ?? title, content, canonicalUrl);
    if (articleFailure) return { ...unavailable(input, articleFailure === 'restricted' ? 'crawler_restricted' : 'crawler_render_failed', status), access: articleFailure };
    return { url: input, canonicalUrl, title: usefulSourceTitle(article?.title ?? title, content, canonicalUrl), content, access: 'public',
      publishedAt: articleDate(result.metadata?.['article:published_time']) ?? articleDate(article?.publishedAt),
      metadata: { status, ...(article ? { media: article.media ?? [], cleaning: article.cleaning ?? 'readability', byline: article.byline,
        ...(article.followupLinks ? { followupLinks: article.followupLinks } : {}),
        ...(article.paper ? { paper: article.paper } : {}) } : {}) } };
  } catch (error) {
    return unavailable(input, error instanceof ResearchFetchError ? error.code
      : signal.aborted ? 'crawler_timeout' : 'crawler_failed');
  }
}
