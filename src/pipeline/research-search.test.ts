import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchPages } from './research-search.js';
import { searchPages as pageSearch } from './research-page.js';
import { fetchPublic, ResearchFetchError } from './research-fetch.js';

vi.mock('./research-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('./research-fetch.js')>(), fetchPublic: vi.fn(),
}));

function rss(links: string[]): string {
  return '<?xml version="1.0"?><rss version="2.0"><channel>' + links.map(link =>
    '<item><title>Untrusted result</title><link>' + link + '</link><description>Not evidence</description></item>')
    .join('') + '</channel></rss>';
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('RESEARCH_SEARCH_URL', '');
  vi.stubEnv('RESEARCH_SEARCH_TOKEN', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('bounded public search fallback', () => {
  it('makes an actual RSS search when no endpoint is configured and exposes URLs only', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status: 200,
      contentType: 'text/xml', text: rss(['https://www.postgresql.org/about/news/']) });
    expect(pageSearch).toBe(searchPages);
    expect(await searchPages('PostgreSQL release', 3)).toEqual(['https://www.postgresql.org/about/news/']);
    const call = vi.mocked(fetchPublic).mock.calls[0];
    if (!call) throw new Error('Missing search request');
    const url = new URL(call[0]);
    expect(url.origin).toBe('https://www.bing.com');
    expect(url.searchParams.get('q')).toBe('PostgreSQL release');
    expect(url.searchParams.get('format')).toBe('rss');
    expect(call[1]).toMatchObject({ maxRedirects: 0, allowXml: true });
    expect(call[2]).toEqual({});
  });

  it('never leaks a configured search token to the public fallback', async () => {
    vi.stubEnv('RESEARCH_SEARCH_TOKEN', 'private-configured-token');
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status: 200,
      contentType: 'text/xml', text: rss([]) });
    expect(await searchPages('public query', 1)).toEqual([]);
    expect(vi.mocked(fetchPublic).mock.calls[0]?.[2]).toEqual({});
  });

  it('decodes only safe RSS text, normalizes and deduplicates candidate URLs', async () => {
    const xml = rss(['http://127.0.0.1/private', 'https://example.org/a#part', 'https://example.org/a',
      '<![CDATA[https://example.org/b?q=release&lang=ru]]>', 'https://example.org/&#x63;']);
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status: 200,
      contentType: 'text/xml', text: xml });
    expect(await searchPages('public query', 3)).toEqual([
      'https://example.org/a', 'https://example.org/b?q=release&lang=ru', 'https://example.org/c',
    ]);
  });

  it('caps requested queries, candidate count and makes just one HTTP submission', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status: 200,
      contentType: 'text/xml', text: rss(Array.from({ length: 30 }, (_, i) => 'https://example.org/' + i)) });
    expect(await searchPages('x'.repeat(1000), 100)).toHaveLength(20);
    expect(fetchPublic).toHaveBeenCalledOnce();
    expect(new URL(vi.mocked(fetchPublic).mock.calls[0]?.[0] ?? '').searchParams.get('q')).toHaveLength(500);
  });

  it('never extracts candidates from descriptions or CDATA snippets', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status: 200,
      contentType: 'text/xml', text: rss(['https://example.org/source']).replace('Not evidence',
        '<![CDATA[<item><link>https://injected.example/</link></item>]]>') });
    expect(await searchPages('public query', 10)).toEqual(['https://example.org/source']);
  });

  it.each([
    '<html><title>Captcha</title></html>',
    '<rss><channel><item><link>https://example.org/</link></channel></rss>',
    '<rss><channel><item><title>No link</title></item></channel></rss>',
    '<!DOCTYPE rss [<!ENTITY secret SYSTEM "file:///etc/passwd">]><rss><channel></channel></rss>',
    rss(['https://example.org/?x=&unknown;']),
    rss(['https://example.org/&#x110000;']),
  ])('rejects challenges and malformed/DTD RSS instead of a successful empty no-op', async text => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status: 200,
      contentType: 'text/html', text });
    await expect(searchPages('private-query-never-log', 2)).rejects.toThrow('unsupported_content');
    expect(fetchPublic).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private-query-never-log');
  });

  it.each([202, 403, 429, 503])('records HTTP %s as bounded unavailable, never retries or fakes results', async status => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://www.bing.com/search', status,
      contentType: 'text/html', text: 'blocked private response body' });
    await expect(searchPages('private-query-never-log', 3)).rejects.toThrow('fetch_failed');
    expect(fetchPublic).toHaveBeenCalledOnce();
    expect(console.warn).toHaveBeenCalledWith('Research search unavailable.',
      { provider: 'bing_rss', code: 'fetch_failed', status });
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private');
  });

  it('propagates SSRF/DNS/size failure codes with safe diagnostics', async () => {
    vi.mocked(fetchPublic).mockRejectedValue(new ResearchFetchError('blocked_url'));
    await expect(searchPages('public query', 1)).rejects.toThrow('blocked_url');
    expect(console.warn).toHaveBeenCalledWith('Research search unavailable.',
      { provider: 'bing_rss', code: 'blocked_url' });
  });

  it('preserves the configured SearxNG JSON endpoint without fallback on failure', async () => {
    vi.stubEnv('RESEARCH_SEARCH_URL', 'https://search.example.org/?language=ru');
    vi.stubEnv('RESEARCH_SEARCH_TOKEN', 'synthetic-secret');
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://search.example.org/', status: 200,
      contentType: 'application/json', text: JSON.stringify({ results: [
        { url: 'https://example.org/source', content: 'Untrusted snippet' },
      ] }) });
    expect(await searchPages('public query', 3)).toEqual(['https://example.org/source']);
    const call = vi.mocked(fetchPublic).mock.calls[0];
    expect(call?.[2]).toEqual({ Authorization: 'Bearer synthetic-secret' });
    expect(call?.[1]).not.toHaveProperty('allowXml');
    expect(new URL(call?.[0] ?? '').searchParams.get('language')).toBe('ru');
    vi.mocked(fetchPublic).mockRejectedValueOnce(new ResearchFetchError('fetch_failed'));
    await expect(searchPages('public query', 3)).rejects.toThrow('fetch_failed');
    expect(fetchPublic).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('synthetic-secret');
  });

  it('makes no request for an exhausted budget or empty query and rejects invalid budgets', async () => {
    expect(await searchPages('public query', 0)).toEqual([]);
    expect(await searchPages('   ', 3)).toEqual([]);
    await expect(searchPages('public query', -1)).rejects.toThrow('nonnegative');
    expect(fetchPublic).not.toHaveBeenCalled();
  });
});
