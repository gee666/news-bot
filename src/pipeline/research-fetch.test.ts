import type { LookupFunction } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublic, isPublicAddress, publicUrl, resolvePublicAddress, envInteger } from './research-fetch.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(),
  agents: [] as { connect: { lookup: LookupFunction }; destroy: ReturnType<typeof vi.fn> }[] }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('undici', () => ({ fetch: mocks.fetch, Agent: class {
  destroy = vi.fn().mockResolvedValue(undefined);
  constructor(config: { connect: { lookup: LookupFunction } }) { mocks.agents.push({ ...config, destroy: this.destroy }); }
} }));

const limits = { timeoutMs: 1000, maxBytes: 100, maxRedirects: 3 };
function response(text = 'public news', status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.agents.length = 0;
  mocks.lookup.mockResolvedValue([{ address: '93.184.215.14', family: 4 }]);
  mocks.fetch.mockResolvedValue(response());
});
afterEach(() => vi.unstubAllEnvs());

describe('public destination checks', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.0.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::1',
    '2001::1', '3fff::1', 'not-an-ip'])('blocks %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '93.184.215.14', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888'])('allows %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each(['file:///etc/passwd', 'ftp://example.org', 'http://localhost/a', 'http://x.localhost/',
    'http://local.internal/', 'http://printer.local/', 'http://192.168.1.1/', 'http://[::1]/',
    'http://user:password@example.org/', 'http://example.org:8080/', 'http://2130706433/',
    'http://0x7f000001/', 'http://127.1/', 'http://169.254.169.254/latest'])('rejects unsafe URL %s', url => {
    expect(() => publicUrl(url)).toThrow('blocked_url');
  });

  it('normalizes a public URL without fragments', () => {
    expect(publicUrl('https://EXAMPLE.org/news#part').href).toBe('https://example.org/news');
  });

  it('rejects mixed DNS answers and empty answers', async () => {
    await expect(resolvePublicAddress('example.org', async () => [
      { address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow('blocked_url');
    await expect(resolvePublicAddress('example.org', async () => [])).rejects.toThrow('blocked_url');
  });
});

describe('bounded pinned fetching', () => {
  it('pins the checked DNS address and keeps the original hostname for TLS and Host', async () => {
    const result = await fetchPublic('https://example.org/news', limits);
    expect(result).toMatchObject({ url: 'https://example.org/news', text: 'public news', status: 200 });
    expect(mocks.lookup).toHaveBeenCalledOnce();
    const pinnedLookup = mocks.agents[0]?.connect.lookup;
    if (!pinnedLookup) throw new Error('Expected an address-pinned agent');
    const callback = vi.fn();
    pinnedLookup('example.org', { all: false }, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.215.14', 4);
    const allCallback = vi.fn();
    pinnedLookup('example.org', { all: true }, allCallback);
    expect(allCallback).toHaveBeenCalledWith(null, [{ address: '93.184.215.14', family: 4 }]);
    expect(mocks.lookup).toHaveBeenCalledOnce();
    expect(mocks.fetch.mock.calls[0]?.[0].hostname).toBe('example.org');
    expect(mocks.agents[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('blocks direct local hosts without resolving or requesting them', async () => {
    await expect(fetchPublic('http://127.0.0.1/', limits)).rejects.toThrow('blocked_url');
    expect(mocks.lookup).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('blocks public DNS names that resolve privately before dispatch', async () => {
    mocks.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(fetchPublic('https://example.org/', limits)).rejects.toThrow('blocked_url');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('checks redirect destinations and their DNS again', async () => {
    mocks.fetch.mockResolvedValueOnce(response('', 302, { location: 'https://redirect.org/' }));
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
      .mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);
    await expect(fetchPublic('https://example.org/', limits)).rejects.toThrow('blocked_url');
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.agents[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('follows bounded relative redirects and rejects loops', async () => {
    mocks.fetch.mockResolvedValueOnce(response('', 302, { location: '/next' })).mockResolvedValueOnce(response('next'));
    expect(await fetchPublic('https://example.org/', limits)).toMatchObject({ url: 'https://example.org/next', text: 'next' });
    mocks.fetch.mockImplementation(async () => response('', 302, { location: '/next' }));
    await expect(fetchPublic('https://example.org/', { ...limits, maxRedirects: 1 })).rejects.toThrow('blocked_url');
  });

  it('never forwards configured search authorization to redirects', async () => {
    mocks.fetch.mockResolvedValueOnce(response('', 302, { location: 'https://other.org/' }));
    await expect(fetchPublic('https://search.org/', limits, { Authorization: 'Bearer synthetic' })).rejects.toThrow('blocked_url');
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('bounds decoded streamed bytes even without content-length', async () => {
    mocks.fetch.mockResolvedValueOnce(response('x'.repeat(101)));
    await expect(fetchPublic('https://example.org/', limits)).rejects.toThrow('too_large');
    expect(mocks.agents[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('rejects declared oversized bodies and non-text content', async () => {
    mocks.fetch.mockResolvedValueOnce(response('x', 200, { 'content-length': '101' }));
    await expect(fetchPublic('https://example.org/', limits)).rejects.toThrow('too_large');
    mocks.fetch.mockResolvedValueOnce(response('x', 200, { 'content-type': 'application/pdf' }));
    await expect(fetchPublic('https://example.org/', limits)).rejects.toThrow('unsupported_content');
  });

  it('accepts RSS XML only when the search caller explicitly opts in', async () => {
    mocks.fetch.mockResolvedValueOnce(response('<rss/>', 200, { 'content-type': 'text/xml' }));
    await expect(fetchPublic('https://example.org/feed', limits)).rejects.toThrow('unsupported_content');
    mocks.fetch.mockResolvedValueOnce(response('<rss/>', 200, { 'content-type': 'text/xml' }));
    expect(await fetchPublic('https://example.org/feed', { ...limits, allowXml: true }))
      .toMatchObject({ contentType: 'text/xml', text: '<rss/>' });
  });

  it('accepts standard Atom MIME only with explicit XML opt-in', async () => {
    mocks.fetch.mockResolvedValueOnce(response('<feed/>', 200, { 'content-type': 'application/atom+xml' }));
    await expect(fetchPublic('https://example.org/feed', limits)).rejects.toThrow('unsupported_content');
    mocks.fetch.mockResolvedValueOnce(response('<feed/>', 200, { 'content-type': 'application/atom+xml' }));
    expect(await fetchPublic('https://example.org/feed', { ...limits, allowXml: true }))
      .toMatchObject({ contentType: 'application/atom+xml', text: '<feed/>' });
  });

  it('does not expose destination URLs or transport errors in diagnostics', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('secret query and internal address'));
    await expect(fetchPublic('https://example.org/?sensitive=hidden', limits)).rejects.toThrow(/^fetch_failed$/u);
    expect(mocks.agents[0]?.destroy).toHaveBeenCalledOnce();
  });

  it('validates environment limits', () => {
    vi.stubEnv('RESEARCH_FETCH_MAX_BYTES', '0');
    expect(() => envInteger('RESEARCH_FETCH_MAX_BYTES', 100, 1000)).toThrow('Invalid RESEARCH_FETCH_MAX_BYTES');
    vi.stubEnv('RESEARCH_FETCH_MAX_BYTES', '500');
    expect(envInteger('RESEARCH_FETCH_MAX_BYTES', 100, 1000)).toBe(500);
  });
});
