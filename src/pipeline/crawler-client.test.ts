import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { fetchCrawlerPage } from './crawler-client.js';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), fetch: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
const url = 'https://example.org/article';
function result(overrides: Record<string, unknown> = {}) {
  return { url, success: true, status_code: 200, redirected_url: url, redirected_status_code: 200,
    markdown: { raw_markdown: '# Article\nFull table | Price | $500 |' },
    metadata: { title: 'Article', 'article:published_time': '2026-09-29' }, ...overrides };
}
function respond(value: unknown) {
  mocks.fetch.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  })));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubEnv('RESEARCH_CRAWLER_URL', 'http://crawl4ai:11235');
  vi.stubEnv('RESEARCH_CRAWLER_API_TOKEN', 'test-secret');
  mocks.lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  respond({ success: true, results: [result()] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Crawl4AI adapter', () => {
  it('uses raw markdown, explicit article date, and the real 0.9.4 typed payload', async () => {
    const page = await fetchCrawlerPage(url);
    expect(page).toMatchObject({ content: '# Article\nFull table | Price | $500 |',
      title: 'Article', canonicalUrl: url, access: 'public', publishedAt: '2026-09-29T00:00:00.000Z',
      metadata: { status: 200 } });
    const [endpoint, init] = mocks.fetch.mock.calls[0] ?? [];
    expect(String(endpoint)).toBe('http://crawl4ai:11235/crawl');
    const request = zRequest(init);
    expect(request.urls).toEqual([url]);
    expect(request.browser_config).toEqual({ type: 'BrowserConfig',
      params: { headless: true, java_script_enabled: true, text_mode: false } });
    expect(request.crawler_config).toEqual({ type: 'CrawlerRunConfig', params: {
      cache_mode: { type: 'CacheMode', params: 'disabled' },
      word_count_threshold: 1, excluded_tags: ['nav', 'footer', 'aside'],
      wait_until: 'domcontentloaded', page_timeout: 30_000, delay_before_return_html: 3,
      scan_full_page: true, max_scroll_steps: 5, scroll_delay: 0.3,
    } });
    expect(JSON.stringify(request)).not.toMatch(/cookies|session_id|magic|proxy_config|js_code|extra_args/u);
  });

  it.each(['https://foreign.example/article', 'https://example.org/another',
    'https://example.org/article?different=true'])('rejects foreign original result identity %s', original => {
    respond({ success: true, results: [result({ url: original, redirected_url: url })] });
    return expect(fetchCrawlerPage(url)).resolves.toMatchObject({ content: null, canonicalUrl: null,
      access: 'unavailable', metadata: { error: 'crawler_result_mismatch' } });
  });

  it('compares normalized originals and accepts a public redirect separately', async () => {
    respond({ success: true, results: [result({ url: 'https://EXAMPLE.org:443/article#ignored',
      status_code: 301, redirected_url: 'https://publisher.example/final', redirected_status_code: 200 })] });
    expect(await fetchCrawlerPage('https://EXAMPLE.org:443/article#section')).toMatchObject({
      canonicalUrl: 'https://publisher.example/final', access: 'public', metadata: { status: 200 },
    });
  });

  it('rejects mixed DNS on a public-looking final redirect', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    respond({ success: true, results: [result({ redirected_url: 'https://publisher.example/final' })] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'blocked_url' } });
  });

  it('article purpose cleans rendered HTML while index purpose preserves discovery Markdown', async () => {
    const html = '<html><head><title>Clean article</title></head><body><article><h1>Clean article</h1><p>We released an open model with code, weights and an explicit license. The detailed report contains the model sizes, evaluation and all comparison settings.</p><h2>Price</h2><table><tr><th>Price</th><th>Speed</th></tr><tr><td>$500</td><td>25x</td></tr></table><p><a href="https://example.org/code">Code</a></p></article><footer>Comment profile</footer></body></html>';
    const raw = '# Index\\n[Card](https://example.org/article)\\nComment profile';
    respond({ success: true, results: [result({ html, markdown: { raw_markdown: raw } })] });
    const article = await fetchCrawlerPage(url, 'article');
    expect(article.content).toContain('$500');
    expect(article.content).toContain('25x');
    expect(article.content).not.toContain('Comment profile');
    expect(article.metadata).toMatchObject({ cleaning: 'readability' });
    expect((await fetchCrawlerPage(url, 'index')).content).toBe(raw);
  });

  it('article purpose fails closed without HTML, rather than admitting page chrome', async () => {
    expect(await fetchCrawlerPage(url, 'article')).toMatchObject({ content: null,
      metadata: { error: 'crawler_article_unavailable' } });
  });

  it('retains headings, headers and short numeric table facts without pruning', async () => {
    const markdown = '# Pricing\n## Limits\n| Price | Current | Previous |\n| --- | --- | --- |\n| $200 | 10x | 20x |\n| $500 | 25x | 300 |';
    respond({ success: true, results: [result({ markdown: { raw_markdown: markdown } })] });
    expect((await fetchCrawlerPage(url)).content).toBe(markdown);
  });

  it.each(['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/',
    'https://user:password@example.org/', 'file:///etc/passwd'])('blocks unsafe target %s', async target => {
    expect(await fetchCrawlerPage(target)).toMatchObject({ content: null, metadata: { error: 'blocked_url' } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blocks mixed DNS and unsafe final destinations', async () => {
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'blocked_url' } });
    expect(mocks.fetch).not.toHaveBeenCalled();
    mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    respond({ success: true, results: [result({ redirected_url: 'http://127.0.0.1/admin' })] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'blocked_url' } });
  });

  it.each([
    { status_code: 403, redirected_status_code: 403 },
    { metadata: { title: 'Just a moment...' } },
    { markdown: { raw_markdown: 'Verify you are human' } },
    { error_message: 'Blocked by anti-bot protection: Cloudflare challenge' },
  ])('does not mistake a challenge for an article', async overrides => {
    respond({ success: true, results: [result(overrides)] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'restricted', content: null, publishedAt: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 login redirect before readability can mistake it for article content', async () => {
    respond({ success: true, results: [result({ redirected_url: 'https://github.com/login?return_to=repo',
      metadata: { title: 'Sign in to GitHub · GitHub' }, html: '<main>Username Password</main>',
      markdown: { raw_markdown: '# Sign in to GitHub\nUsername Password' } })] });
    expect(await fetchCrawlerPage(url, 'article')).toMatchObject({ access: 'restricted', content: null, title: null,
      metadata: { error: 'crawler_restricted', status: 200 } });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('rejects repeated completed 200 SPA load-error shells after bounded retries', async () => {
    respond({ success: true, results: [result({ metadata: { title: null },
      markdown: { raw_markdown: '# This page couldn’t load\\nReload to try again, or go back.' } })] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'unavailable', content: null,
      metadata: { error: 'crawler_render_failed' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(3);
  });

  it('retries a completed shell after a delay and returns the second article', async () => {
    const shell = result({ markdown: { raw_markdown: '# This page could not load' } });
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, results: [shell] }),
      { headers: { 'Content-Type': 'application/json' } }));
    const started = Date.now();
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'public', title: 'Article' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    const [first, second] = mocks.fetch.mock.calls;
    const firstInit = z.object({ signal: z.instanceof(AbortSignal), body: z.string() }).parse(first?.[1]);
    const secondInit = z.object({ signal: z.instanceof(AbortSignal), body: z.string() }).parse(second?.[1]);
    expect(secondInit.signal).toBe(firstInit.signal);
    expect(secondInit.body).toBe(firstInit.body);
  });

  it('stops when the shared deadline expires during retry delay', async () => {
    vi.stubEnv('RESEARCH_CRAWLER_TIMEOUT_MS', '25');
    respond({ success: true, results: [result({ markdown: { raw_markdown: '# This page could not load' } })] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'crawler_timeout' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not reset the deadline for an in-flight second request', async () => {
    vi.stubEnv('RESEARCH_CRAWLER_TIMEOUT_MS', '1100');
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ success: true,
      results: [result({ markdown: { raw_markdown: '# This page could not load' } })] }),
    { headers: { 'Content-Type': 'application/json' } }));
    mocks.fetch.mockImplementationOnce((_endpoint: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const started = Date.now();
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'crawler_timeout' } });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([404, 500, 201])('does not retry a shell with HTTP %s', async status => {
    respond({ success: true, results: [result({ status_code: status, redirected_status_code: status,
      markdown: { raw_markdown: '# This page could not load' } })] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'unavailable', content: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unsuccessful SDK result with shell text', async () => {
    respond({ success: true, results: [result({ success: false,
      markdown: { raw_markdown: '# This page could not load' } })] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_failed' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds target DNS resolution with the request deadline', async () => {
    vi.stubEnv('RESEARCH_CRAWLER_TIMEOUT_MS', '10');
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_timeout' } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    { success: false }, { status_code: null, redirected_status_code: null },
    { status_code: 404, redirected_status_code: 404 }, { markdown: { raw_markdown: '  ' } },
  ])('requires successful HTTP and nonempty content', async overrides => {
    respond({ success: true, results: [result(overrides)] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'unavailable', content: null });
  });

  it.each([
    { title: 'Article', published_time: '2026-09-29', 'og:updated_time': '2026-09-30' },
    { title: 'Article', 'article:published_time': 'September 29 2026' },
    { title: 'Article', 'article:published_time': '2026-02-31' },
  ])('keeps publication unknown without a valid explicit article timestamp', async metadata => {
    respond({ success: true, results: [result({ metadata })] });
    expect((await fetchCrawlerPage(url)).publishedAt).toBeNull();
  });

  it.each([{ success: true, results: [] }, { success: true, results: [result(), result()] },
    { success: true, results: [result({ status_code: '200' })] },
    { success: true, results: [result({ markdown: '# legacy string' })] }])('validates response schema', async value => {
    respond(value);
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'crawler_invalid_response' } });
  });

  it('bounds network response bytes but retains full rendered text', async () => {
    vi.stubEnv('RESEARCH_CRAWLER_MAX_BYTES', '10');
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: null, metadata: { error: 'crawler_response_too_large' } });
    vi.stubEnv('RESEARCH_CRAWLER_MAX_BYTES', '5000000');
    respond({ success: true, results: [result()] });
    expect(await fetchCrawlerPage(url)).toMatchObject({ content: '# Article\nFull table | Price | $500 |', metadata: { status: 200 } });
  });

  it('does not retry an unknown in-flight timeout', async () => {
    vi.stubEnv('RESEARCH_CRAWLER_TIMEOUT_MS', '25');
    mocks.fetch.mockImplementation((_endpoint: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_timeout' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry malformed JSON or failed API authentication', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response('{', { headers: { 'Content-Type': 'application/json' } }));
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'unavailable', content: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    mocks.fetch.mockClear();
    mocks.fetch.mockResolvedValueOnce(new Response('auth failed', { status: 401 }));
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_http_401' } });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not leak service errors or secrets', async () => {
    mocks.fetch.mockRejectedValue(new Error('test-secret connection detail'));
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_failed' } });
    mocks.fetch.mockResolvedValue(new Response('test-secret', { status: 403 }));
    expect(await fetchCrawlerPage(url)).toMatchObject({ access: 'unavailable',
      metadata: { error: 'crawler_http_403' } });
  });

  it('does not use an unconfigured or credential-bearing service endpoint', async () => {
    vi.stubEnv('RESEARCH_CRAWLER_API_TOKEN', '');
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_not_configured' } });
    vi.stubEnv('RESEARCH_CRAWLER_API_TOKEN', 'test-secret');
    vi.stubEnv('RESEARCH_CRAWLER_URL', 'http://user:secret@crawl4ai:11235');
    expect(await fetchCrawlerPage(url)).toMatchObject({ metadata: { error: 'crawler_invalid_endpoint' } });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

function zRequest(value: unknown) {
  const init = z.object({ body: z.string() }).parse(value);
  return z.object({ urls: z.array(z.string()), browser_config: z.unknown(),
    crawler_config: z.unknown() }).parse(JSON.parse(init.body));
}

it('uses a clean Reddit permalink and does not publish transient challenge redirect parameters', async () => {
  const reddit = 'https://www.reddit.com/r/StableDiffusion/comments/1xdoh8k/gpu_unlock/';
  const dirty = reddit+'?solution=one&js_challenge=1&jsc_token=token&jsc_orig_r=';
  respond({ success:true,results:[result({ url:reddit,redirected_url:dirty+'#discussion' })] });
  const page = await fetchCrawlerPage(dirty);
  expect(page.url).toBe(dirty);
  expect(page.canonicalUrl).toBe(reddit);
  expect(zRequest(mocks.fetch.mock.calls[0]?.[1]).urls).toEqual([reddit]);
});
