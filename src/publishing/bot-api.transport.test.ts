import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errors } from 'undici';
import { BotApi, BotError } from './bot-api.js';
import { render } from './render.js';

const token = '123:synthetic';
const destination = '-100123';
const message = render({ headline: 'News', score: 1, details: '', detailsKind: 'excerpt', sources: [] });
const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from('image') };
const video = { type: 'video' as const, mimeType: 'video/mp4', data: Buffer.from('video') };
const document = { type: 'image' as const, mimeType: 'image/webp', data: Buffer.from('document') };
const result = (id = 9) => ({ message_id: id, chat: { id: Number(destination) } });
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, result: value }));
const fetchFailure = (cause: unknown) => new TypeError('fetch failed', { cause });
const systemError = (code: string, syscall: string) => Object.assign(new Error(`private https://api.telegram.org/bot${token}`), { code, syscall });

beforeEach(() => {
  vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', undefined);
  vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('Bot API transport timeout selection', () => {
  it.each([
    { request: undefined, upload: undefined, requestMs: 30_000, uploadMs: 300_000 },
    { request: '45000', upload: '600000', requestMs: 45_000, uploadMs: 600_000 },
  ])('uses the request window for text, getMe, edits and deletion: %j', async config => {
    vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', config.request);
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', config.upload);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      if (String(input).endsWith('/getMe')) return response({ id: 123, is_bot: true });
      if (String(input).endsWith('/deleteMessage')) return response(true);
      return response(result());
    });
    const api = new BotApi(token, fetcher);
    await api.send(destination, message);
    await api.identity();
    await api.edit(destination, '9', message);
    await api.editCaption(destination, '9', message);
    await api.delete(destination, '9');
    expect(timeout.mock.calls).toEqual(Array.from({ length: 5 }, () => [config.requestMs]));
    for (const [index, call] of fetcher.mock.calls.entries()) {
      expect(call[1]?.signal).toBe(timeout.mock.results[index]?.value);
      expect(call[1]?.redirect).toBe('error');
    }
  });
  it.each([
    { request: undefined, upload: undefined, uploadMs: 300_000 },
    { request: '45000', upload: '900000', uploadMs: 900_000 },
  ])('uses the upload window for single media and groups in both sending modes: %j', async config => {
    vi.stubEnv('TELEGRAM_REQUEST_TIMEOUT_MS', config.request);
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', config.upload);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => response(
      String(input).endsWith('/sendMediaGroup') ? [result(), result(10)] : result(),
    ));
    const api = new BotApi(token, fetcher);
    for (const media of [[image], [video], [document], [image, video], [document, document]]) {
      await api.sendMedia(destination, '8', media);
      await api.sendAlbum(destination, message, media);
    }
    expect(timeout.mock.calls).toEqual(Array.from({ length: 10 }, () => [config.uploadMs]));
    for (const [index, call] of fetcher.mock.calls.entries()) {
      expect(call[1]?.body).toBeInstanceOf(FormData);
      expect(call[1]?.signal).toBe(timeout.mock.results[index]?.value);
      expect(call[1]?.redirect).toBe('error');
    }
  });
  it('rejects invalid config before touching the network, not as an uncertain transport failure', async () => {
    vi.stubEnv('TELEGRAM_UPLOAD_TIMEOUT_MS', 'private-credential');
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BotApi(token, fetcher).sendAlbum(destination, message, [image]))
      .rejects.toThrow(new Error('telegram_upload_timeout_ms_invalid'));
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Bot API safe transport outcomes', () => {
  it.each([
    new errors.ConnectTimeoutError(`private ${token}`),
    systemError('ENOTFOUND', 'getaddrinfo'), systemError('EAI_AGAIN', 'getaddrinfo'),
    systemError('ECONNREFUSED', 'connect'), systemError('ENETUNREACH', 'connect'),
    new AggregateError([systemError('ECONNREFUSED', 'connect'), systemError('ENETUNREACH', 'connect')]),
  ])('returns a sanitized retryable error without internally repeating a mutation: %s', async cause => {
    for (const operation of ['text', 'album', 'media'] as const) {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(fetchFailure(cause));
      const api = new BotApi(token, fetcher);
      const send = operation === 'text' ? api.send(destination, message)
        : operation === 'album' ? api.sendAlbum(destination, message, [image]) : api.sendMedia(destination, '8', [image]);
      const error: unknown = await send.catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(BotError);
      expect(error).toMatchObject({ code: 'telegram_connect_failed', outcome: 'retryable', retryAfterMs: 0 });
      if (!(error instanceof BotError)) throw new Error('Expected a safe BotError');
      expect(error.cause).toBeUndefined();
      expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(/synthetic|private|api\.telegram/u);
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it.each([
    new TypeError('fetch failed'), new Error(`private ${token}`), fetchFailure(new Error('unexpected redirect')),
    new DOMException('private abort', 'AbortError'), new DOMException('private deadline', 'TimeoutError'),
    fetchFailure(systemError('ECONNRESET', 'read')), fetchFailure(systemError('ETIMEDOUT', 'connect')),
    fetchFailure(new errors.SocketError(`private ${token}`)),
    fetchFailure(new errors.HeadersTimeoutError()), fetchFailure(new errors.BodyTimeoutError()),
    fetchFailure(systemError('ECONNREFUSED', 'write')),
    fetchFailure(new AggregateError([systemError('ECONNREFUSED', 'connect'), systemError('ECONNRESET', 'read')])),
    fetchFailure(Object.assign(new AggregateError([]), { code: 'ECONNREFUSED' })),
  ])('keeps ambiguous transport failures unknown and never retries: %s', async failure => {
    for (const operation of ['text', 'album', 'identity'] as const) {
      const fetcher = vi.fn<typeof fetch>().mockRejectedValue(failure);
      const api = new BotApi(token, fetcher);
      const send = operation === 'text' ? api.send(destination, message)
        : operation === 'album' ? api.sendAlbum(destination, message, [image]) : api.identity();
      await expect(send).rejects.toMatchObject({ code: 'telegram_transport_unknown', outcome: 'unknown' });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('does not classify response-body failures as pre-connect, even if they carry connect-like codes', async () => {
    const reply = response(result());
    vi.spyOn(reply, 'json').mockRejectedValue(fetchFailure(systemError('ECONNREFUSED', 'connect')));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply);
    await expect(new BotApi(token, fetcher).send(destination, message))
      .rejects.toMatchObject({ code: 'telegram_response_unknown', outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('returns getMe pre-connect failures without retrying, and caches only a later successful identity', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(fetchFailure(new errors.ConnectTimeoutError()))
      .mockResolvedValue(response({ id: 123, is_bot: true }));
    const api = new BotApi(token, fetcher);
    await expect(api.identity()).rejects.toMatchObject({ code: 'telegram_connect_failed', outcome: 'retryable' });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(api.identity()).resolves.toEqual({ id: 123, is_bot: true });
    await expect(api.identity()).resolves.toEqual({ id: 123, is_bot: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
