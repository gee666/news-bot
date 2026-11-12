import { beforeEach, expect, it, vi } from 'vitest';
import { downloadMedia } from './download.js';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), client: vi.fn(), messages: vi.fn(), download: vi.fn(), disconnect: vi.fn() }));
vi.mock('../pipeline/research-fetch.js', () => ({ fetchPublicMedia: mocks.fetch }));
vi.mock('../telegram/client.js', () => ({ withUserClient: mocks.client }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.client.mockImplementation(async run => run({ getMessages: mocks.messages, downloadMedia: mocks.download, disconnect: mocks.disconnect }));
});

it('passes the cancellation signal through public-media fetches', async () => {
  const controller = new AbortController();
  const data = Buffer.from('image');
  mocks.fetch.mockResolvedValue({ status: 200, contentType: 'image/jpeg', data });
  expect(await downloadMedia({ type: 'image', url: 'https://example.org/photo.jpg' }, { metadata: {} }, controller.signal))
    .toEqual({ type: 'image', mimeType: 'image/jpeg', data });
  expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('https://example.org/photo.jpg', 9_000_000, controller.signal);
});

it('does not open HTTP or Telegram clients after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(downloadMedia({ type: 'image', url: 'https://example.org/photo.jpg' }, { metadata: {} }, controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.fetch).not.toHaveBeenCalled();
  expect(mocks.client).not.toHaveBeenCalled();
});

it('disconnects a stalled Telegram request and never starts its late file download', async () => {
  const controller = new AbortController();
  let finish: (messages: Array<{ media: object }>) => void = () => {};
  mocks.messages.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const task = downloadMedia({ type: 'image', telegramMessageId: 1 },
    { metadata: { channelId: '123', accessHash: '456' } }, controller.signal);
  const failed = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await failed;
  expect(mocks.disconnect).toHaveBeenCalledOnce();
  finish([{ media: {} }]);
  await Promise.resolve();
  await Promise.resolve();
  expect(mocks.download).not.toHaveBeenCalled();
});

it('checks cancellation in Telegram download progress and rejects late bytes', async () => {
  const controller = new AbortController();
  mocks.messages.mockResolvedValue([{ media: {} }]);
  mocks.download.mockImplementation(async (_message, options) => {
    controller.abort();
    await options.progressCallback(1, 2);
    return Buffer.from('late image');
  });
  await expect(downloadMedia({ type: 'image', telegramMessageId: 1 },
    { metadata: { channelId: '123', accessHash: '456' } }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.disconnect).toHaveBeenCalledOnce();
});
