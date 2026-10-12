import { z } from 'zod';
import { fetchLimits, fetchPublic, publicUrl, ResearchFetchError } from './research-fetch.js';

const defaultSearchUrl = 'https://www.bing.com/search';
const searchResults = z.object({ results: z.array(z.object({ url: z.string().max(4096) })).max(1000) });
const maxResults = 20;

/** Candidate URLs only. Snippets are neither returned nor treated as evidence. */
export async function searchPages(query: string, limit: number): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Search limit must be a nonnegative integer');
  if (limit === 0 || !query.trim()) return [];
  const configured = process.env.RESEARCH_SEARCH_URL?.trim();
  const provider = configured ? 'searxng' : 'bing_rss';
  let status: number | undefined;
  try {
    const url = publicUrl(configured || defaultSearchUrl);
    url.searchParams.set('q', query.trim().slice(0, 500));
    url.searchParams.set('format', configured ? 'json' : 'rss');
    // A configured token belongs only to that endpoint, never the public fallback.
    const token = configured ? process.env.RESEARCH_SEARCH_TOKEN : undefined;
    const response = await fetchPublic(url.href,
      { ...fetchLimits(), maxRedirects: 0, ...(!configured ? { allowXml: true } : {}) },
      token ? { Authorization: `Bearer ${token}` } : {});
    status = response.status;
    if (status !== 200) throw new ResearchFetchError('fetch_failed');
    const results = configured ? parseJsonResults(response.text) : parseRssLinks(response.text);
    const urls = new Set<string>();
    for (const result of results) {
      try { urls.add(publicUrl(result).href); } catch { continue; }
      if (urls.size >= Math.min(limit, maxResults)) break;
    }
    return [...urls];
  } catch (error) {
    if (!(error instanceof ResearchFetchError)) throw error;
    // The host's bounded search loop can continue with attribution to available mentions.
    // Never log the query, response body, endpoint credentials or search snippets.
    console.warn('Research search unavailable.', { provider, code: error.code,
      ...(status === undefined ? {} : { status }) });
    throw error;
  }
}

function parseJsonResults(text: string): string[] {
  let json: unknown;
  try { json = JSON.parse(text); } catch { throw new ResearchFetchError('unsupported_content'); }
  const parsed = searchResults.safeParse(json);
  if (!parsed.success) throw new ResearchFetchError('unsupported_content');
  return parsed.data.results.map(result => result.url);
}

/** Read only Bing's RSS 2.0 item/link fields; no DTD, entity resolver or general XML evaluation. */
function parseRssLinks(text: string): string[] {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/iu.test(text)) throw new ResearchFetchError('unsupported_content');
  // Opaque CDATA cannot manufacture markup, even when it contains fake item/link tags.
  const xml = text.replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, (_match: string, value: string) =>
      value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;'));
  if (!/<rss\b[^>]*>/iu.test(xml) || !/<\/rss\s*>\s*$/iu.test(xml)) {
    throw new ResearchFetchError('unsupported_content');
  }
  const channel = /<channel\b[^>]*>([\s\S]*?)<\/channel\s*>/iu.exec(xml)?.[1];
  if (channel === undefined) throw new ResearchFetchError('unsupported_content');
  // A description is untrusted search text, never a source of candidate links.
  const content = channel.replace(/<description\b[^>]*>[\s\S]*?<\/description\s*>/giu, '');
  const items = [...content.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/giu)];
  if (items.length > 1000 || items.length !== (content.match(/<item\b/giu) ?? []).length) {
    throw new ResearchFetchError('unsupported_content');
  }
  const links: string[] = [];
  for (const item of items) {
    const value = /<link\b[^>]*>([^<]*)<\/link\s*>/iu.exec(item[1] ?? '')?.[1];
    if (value === undefined) throw new ResearchFetchError('unsupported_content');
    links.push(decodeXml(value.trim()));
  }
  return links;
}

function decodeXml(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/iu.test(value)) {
    throw new ResearchFetchError('unsupported_content');
  }
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, (_match: string, entity: string) => {
    const key = entity.toLowerCase();
    if (Object.hasOwn(named, key)) return named[key] ?? '';
    const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
    if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      throw new ResearchFetchError('unsupported_content');
    }
    return String.fromCodePoint(code);
  });
}
