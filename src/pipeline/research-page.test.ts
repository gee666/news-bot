import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPage, htmlText, searchPages } from './research-page.js';
import { fetchPublic, ResearchFetchError } from './research-fetch.js';
import { fetchCrawlerPage } from './crawler-client.js';

vi.mock('./crawler-client.js', () => ({ fetchCrawlerPage: vi.fn() }));

vi.mock('./research-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('./research-fetch.js')>(), fetchPublic: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('RESEARCH_CRAWLER_URL', '');
  vi.stubEnv('RESEARCH_CRAWLER_API_TOKEN', '');
  vi.stubEnv('RESEARCH_SEARCH_URL', '');
  vi.stubEnv('RESEARCH_SEARCH_TOKEN', '');
});
afterEach(() => vi.unstubAllEnvs());

describe('page preparation', () => {
  it('removes scripts, styles and comments, decodes text entities without executing HTML', () => {
    expect(htmlText('<title>News &amp; releases</title><script>doBadThings()</script><style>.bad{}</style><!-- hidden -->'
      + '<main>Acme&nbsp;released <b>2.0</b>. &#1053;&#x43E;&#x432;ости &lt;quoted&gt; &#x110000;</main>'))
      .toEqual({ title: 'News & releases', content: 'News & releases Acme released 2.0. Новости <quoted>' });
  });

  it('retains the final redirected URL and full public text', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://example.org/final', status: 200,
      contentType: 'text/html', text: '<title>Release</title><main>Long text about a release.</main>' });
    expect(await fetchPage('https://example.org/start')).toMatchObject({ url: 'https://example.org/start',
      canonicalUrl: 'https://example.org/final', title: 'Release', content: 'Long text about a release.', access: 'public',
      metadata: { status: 200 } });
  });

  it.each([401, 403, 404, 503])('stores HTTP %s as inaccessible, not fetched evidence', async status => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://example.org/', status, contentType: 'text/html', text: 'Login/error screen' });
    expect(await fetchPage('https://example.org/')).toMatchObject({ access: [401, 403].includes(status) ? 'restricted' : 'unavailable',
      content: null, title: null, metadata: { status } });
  });

  it('stores SSRF and fetch failures as safe unavailable candidates', async () => {
    vi.mocked(fetchPublic).mockRejectedValue(new ResearchFetchError('blocked_url'));
    expect(await fetchPage('http://127.0.0.1/')).toMatchObject({ content: null, access: 'unavailable', metadata: { error: 'blocked_url' } });
  });

  it('does not classify an empty successful body as public evidence', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://example.org/', status: 200, contentType: 'text/plain', text: ' ' });
    expect(await fetchPage('https://example.org/')).toMatchObject({ content: null, access: 'unavailable' });
  });
});

describe('preferred JS reader', () => {
  beforeEach(() => {
    vi.stubEnv('RESEARCH_CRAWLER_URL', 'http://crawler:11235');
    vi.stubEnv('RESEARCH_CRAWLER_API_TOKEN', 'test-token');
  });

  it('uses rendered public markdown and explicit dates without authority labeling or a second fetch', async () => {
    vi.mocked(fetchCrawlerPage).mockResolvedValue({ url: 'https://publisher.org/article', canonicalUrl: 'https://publisher.org/article',
      title: 'JS article', content: '# Announcement', access: 'public', publishedAt: '2026-09-29T00:00:00.000Z',
      metadata: { status: 200 } });
    const page = await fetchPage('https://publisher.org/article');
    expect(page).toMatchObject({ access: 'public', content: '# Announcement',
      metadata: { method: 'crawl4ai', contentFormat: 'markdown', publishedAt: '2026-09-29T00:00:00.000Z',
        updatedAt: null, fetchedAt: expect.any(String) } });
    expect(page).not.toHaveProperty('role');
    expect(fetchCrawlerPage).toHaveBeenCalledOnce();
    expect(fetchPublic).not.toHaveBeenCalled();
  });

  it.each(['crawler_timeout', 'crawler_http_503', 'crawler_failed', 'crawler_empty_content', 'crawler_render_failed', 'crawler_article_unavailable'])('falls back once for service failure %s', async error => {
    vi.mocked(fetchCrawlerPage).mockResolvedValue({ url: 'https://publisher.org/article', canonicalUrl: null,
      title: null, content: null, access: 'unavailable', publishedAt: null, metadata: { error } });
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://publisher.org/article', status: 200,
      contentType: 'text/html', text: '<title>Article</title><main>Actual article</main>' });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({
      access: 'public', metadata: { method: 'http', contentFormat: 'markdown', cleaning: 'readability', crawlerError: error } });
    expect(fetchCrawlerPage).toHaveBeenCalledOnce();
    expect(fetchPublic).toHaveBeenCalledOnce();
  });

  it.each(['crawler_article_unavailable', 'crawler_empty_content', 'crawler_render_failed'])('recovers HTTP200 extraction failure %s through the bounded HTTP reader', async error => {
    vi.mocked(fetchCrawlerPage).mockResolvedValue({ url: 'https://publisher.org/article', canonicalUrl: 'https://publisher.org/article',
      title: null, content: null, access: 'unavailable', publishedAt: null, metadata: { status: 200, error } });
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://publisher.org/article', status: 200,
      contentType: 'text/html', text: '<title>Actual release</title><main>Actual release announcement text.</main>' });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({ access: 'public', title: 'Actual release',
      content: 'Actual release announcement text.', metadata: { status: 200, method: 'http', crawlerError: error } });
    expect(fetchCrawlerPage).toHaveBeenCalledOnce();
    expect(fetchPublic).toHaveBeenCalledOnce();
  });

  it.each(['crawler_failed', 'crawler_article_unavailable', 'crawler_empty_content', 'crawler_render_failed'])('does not override genuine HTTP404 with %s', async error => {
    vi.mocked(fetchCrawlerPage).mockResolvedValue({ url: 'https://publisher.org/missing', canonicalUrl: null,
      title: null, content: null, access: 'unavailable', publishedAt: null, metadata: { status: 404, error } });
    expect(await fetchPage('https://publisher.org/missing')).toMatchObject({ access: 'unavailable', content: null, metadata: { status: 404, error } });
    expect(fetchPublic).not.toHaveBeenCalled();
  });

  it.each(['Sign in to GitHub · GitHub', 'Just a moment'])('does not retry an HTTP200 restricted screen %s', async title => {
    vi.mocked(fetchCrawlerPage).mockResolvedValue({ url: 'https://publisher.org/article', canonicalUrl: 'https://publisher.org/login',
      title, content: null, access: 'restricted', publishedAt: null, metadata: { status: 200, error: 'crawler_restricted' } });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({ access: 'restricted', content: null,
      metadata: { status: 200, error: 'crawler_restricted' } });
    expect(fetchPublic).not.toHaveBeenCalled();
  });

  it.each(['crawler_restricted', 'blocked_url'])('does not retry %s', async error => {
    vi.mocked(fetchCrawlerPage).mockResolvedValue({ url: 'https://publisher.org/article', canonicalUrl: null,
      title: null, content: null, access: error === 'crawler_restricted' ? 'restricted' : 'unavailable',
      publishedAt: null, metadata: { error } });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({ content: null, metadata: { error } });
    expect(fetchPublic).not.toHaveBeenCalled();
    expect(fetchCrawlerPage).toHaveBeenCalledOnce();
  });

  it('blocks private targets before either reader', async () => {
    expect(await fetchPage('http://127.0.0.1/private')).toMatchObject({ content: null, metadata: { error: 'blocked_url' } });
    expect(fetchPublic).not.toHaveBeenCalled();
    expect(fetchCrawlerPage).not.toHaveBeenCalled();
  });
});

describe('publisher dates and challenge handling', () => {
  it('reads an arXiv PDF reference through its lawful author abstract without claiming PDF content', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://arxiv.org/abs/2609.16247', status: 200, contentType: 'text/html',
      text: '<head><meta name="citation_title" content="The Pain Axis"></head><h1 class="title">Title:The Pain Axis</h1>'
        + '<blockquote class="abstract">Abstract:Actual author findings in the abstract.</blockquote>' });
    expect(await fetchPage('https://arxiv.org/pdf/2609.16247.pdf')).toMatchObject({
      url: 'https://arxiv.org/pdf/2609.16247.pdf', canonicalUrl: 'https://arxiv.org/abs/2609.16247',
      title: 'The Pain Axis', content: '# The Pain Axis\n\n## Abstract\n\nActual author findings in the abstract.', access: 'public' });
    expect(fetchPublic).toHaveBeenCalledWith('https://arxiv.org/abs/2609.16247');
  });

  it.each([
    ['Sign in to GitHub · GitHub', 'https://github.com/login', 'restricted'],
    ['This page couldn’t load', 'https://publisher.org/article', 'unavailable'],
  ])('does not admit HTTP 200 %s as successfully read evidence', async (title, finalUrl, access) => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: finalUrl, status: 200, contentType: 'text/html',
      text: `<title>${title}</title><main>Login or reload controls.</main>` });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({ access, content: null, title: null });
  });

  it('extracts only explicit page-head dates, ignoring related cards and relative update labels', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://publisher.org/article', status: 200, contentType: 'text/html',
      text: '<head><meta property="article:published_time" content="2026-09-29T12:00:00Z">'
        + '<meta content="2026-09-30" property="article:modified_time"></head>'
        + '<main>Updated 2 days ago<aside><meta property="article:published_time" content="2020-01-01"></aside></main>' });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({
      publishedAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-30T00:00:00.000Z' });
  });

  it('keeps relative and related-card dates unknown', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://publisher.org/article', status: 200, contentType: 'text/html',
      text: '<head><meta property="article:modified_time" content="Updated 2 days ago"></head>'
        + '<main>Article<aside><meta property="article:published_time" content="2020-01-01"></aside></main>' });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({ publishedAt: null, updatedAt: null });
  });

  it('does not turn a successful static challenge into an article', async () => {
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://publisher.org/article', status: 200, contentType: 'text/html',
      text: '<title>Just a moment</title><p>Verify that you are human</p>' });
    expect(await fetchPage('https://publisher.org/article')).toMatchObject({ content: null, access: 'restricted' });
  });
});

describe('configured search', () => {
  it('makes no request when the search budget is zero', async () => {
    expect(await searchPages('Synthetic public news', 0)).toEqual([]);
    expect(fetchPublic).not.toHaveBeenCalled();
  });

  it('validates JSON results, deduplicates and filters unsafe destinations without persisting snippets', async () => {
    vi.stubEnv('RESEARCH_SEARCH_URL', 'https://search.example.org/search?language=en');
    vi.stubEnv('RESEARCH_SEARCH_TOKEN', 'synthetic-token');
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://search.example.org/search', status: 200,
      contentType: 'application/json', text: JSON.stringify({ results: [
        { url: 'http://127.0.0.1/private', content: 'private snippet' },
        { url: 'https://example.org/one#part', content: 'public snippet' },
        { url: 'https://example.org/one' }, { url: 'https://example.org/two' }, { url: 'https://example.org/three' },
      ] }) });
    expect(await searchPages('Release of version 2', 2)).toEqual(['https://example.org/one', 'https://example.org/two']);
    const call = vi.mocked(fetchPublic).mock.calls[0];
    if (!call) throw new Error('Expected search dispatch');
    const url = new URL(call[0]);
    expect(url.searchParams.get('q')).toBe('Release of version 2');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('language')).toBe('en');
    expect(call[1]).toMatchObject({ maxRedirects: 0 });
    expect(call[2]).toEqual({ Authorization: 'Bearer synthetic-token' });
  });

  it.each(['not JSON', '{"results":[{"url":42}]}', '{"unexpected":[]}'])('rejects malformed search data %s', async text => {
    vi.stubEnv('RESEARCH_SEARCH_URL', 'https://search.example.org/');
    vi.mocked(fetchPublic).mockResolvedValue({ url: 'https://search.example.org/', status: 200, contentType: 'application/json', text });
    await expect(searchPages('public query', 3)).rejects.toThrow('unsupported_content');
  });

  it('rejects private search endpoints independently of inference approval', async () => {
    vi.stubEnv('RESEARCH_SEARCH_URL', 'http://127.0.0.1/search');
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'true');
    await expect(searchPages('public query', 3)).rejects.toThrow('blocked_url');
    expect(fetchPublic).not.toHaveBeenCalled();
  });
});
