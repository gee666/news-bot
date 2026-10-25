import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readHttp } from './research-page.js';
import { fetchPublic, ResearchFetchError } from './research-fetch.js';
vi.mock('./research-fetch.js', async importOriginal => ({
  ...await importOriginal<typeof import('./research-fetch.js')>(), fetchPublic: vi.fn(),
}));
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv('RESEARCH_HTTP_MAX_ATTEMPTS', '2'); });
afterEach(() => vi.unstubAllEnvs());
const response = (status: number) => ({ url: 'https://publisher.org/article', status, contentType: 'text/html', text: 'Actual response' });
it('retries a transient status within a fixed attempt count', async () => {
  vi.mocked(fetchPublic).mockResolvedValueOnce(response(503)).mockResolvedValueOnce(response(200));
  expect((await readHttp('https://publisher.org/article')).status).toBe(200);
  expect(fetchPublic).toHaveBeenCalledTimes(2);
});
it('returns the final server failure instead of inventing content or retrying forever', async () => {
  vi.mocked(fetchPublic).mockResolvedValue(response(429));
  expect((await readHttp('https://publisher.org/article')).status).toBe(429);
  expect(fetchPublic).toHaveBeenCalledTimes(2);
});
it('retries a network failure but not a second failed request', async () => {
  vi.mocked(fetchPublic).mockRejectedValue(new ResearchFetchError('fetch_failed'));
  await expect(readHttp('https://publisher.org/article')).rejects.toThrow('fetch_failed');
  expect(fetchPublic).toHaveBeenCalledTimes(2);
});
it.each(['blocked_url', 'too_large', 'unsupported_content'] as const)('does not retry %s', async code => {
  vi.mocked(fetchPublic).mockRejectedValue(new ResearchFetchError(code));
  await expect(readHttp('https://publisher.org/article')).rejects.toThrow(code);
  expect(fetchPublic).toHaveBeenCalledOnce();
});
it.each([401, 403, 404])('does not retry access/missing status %s', async status => {
  vi.mocked(fetchPublic).mockResolvedValue(response(status));
  expect((await readHttp('https://publisher.org/article')).status).toBe(status);
  expect(fetchPublic).toHaveBeenCalledOnce();
});
