import { describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import { render } from './render.js';

const message = render({ headline: 'Новость', score: 1, details: '', detailsKind: 'excerpt', sources: [] });
const token = '123:synthetic';
function response(body: object, status = 200): Response { return new Response(JSON.stringify(body),{ status }); }

describe('Telegram Bot API', () => {
  it('clears old inline keyboards on a full-post edit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: { message_id: 9, chat: { id: -100123 } } }));
    await new BotApi(token,fetcher).edit('-100123','9',message);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).reply_markup).toEqual({ inline_keyboard: [] });
  });
  it('treats repeated deletion of an absent message as successful, but not permission failures', async () => {
    await expect(new BotApi(token,vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error_code: 400,
      description: 'Bad Request: message to delete not found' }))).delete('-100123','9')).resolves.toBeUndefined();
    await expect(new BotApi(token,vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error_code: 403 }))).delete('-100123','9')).rejects.toMatchObject({ outcome: 'failed' });
  });

  it('sends with numeric destination and returns only a matching message id', async () => {
    const api = new BotApi(token,vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: { message_id: 9, chat: { id: -100123 } } })));
    expect(await api.send('-100123',message)).toBe('9');
  });

  it('persists Retry-After information in safe errors without exposing token or response', async () => {
    const api = new BotApi(token,vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error_code: 429,
      description: 'private text', parameters: { retry_after: 17 } },429)));
    await expect(api.send('-100123',message)).rejects.toMatchObject({ code: 'telegram_rate_limit', outcome: 'retryable', retryAfterMs: 17000 });
  });

  it('treats timeouts, server failures and malformed successful sends as uncertain, not safe to resend', async () => {
    for (const fetcher of [vi.fn<typeof fetch>().mockRejectedValue(new Error(token)),
      vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error_code: 503 },503)),
      vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: {} }))]) {
      await expect(new BotApi(token,fetcher).send('-100123',message)).rejects.toMatchObject({ outcome: 'unknown' });
    }
  });

  it('accepts an identical edit response as success and rejects definite permission errors', async () => {
    const api = new BotApi(token,vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error_code: 400,
      description: 'Bad Request: message is not modified' })));
    await expect(api.edit('-100123','9',message)).resolves.toBeUndefined();
    const denied = new BotApi(token,vi.fn<typeof fetch>().mockResolvedValue(response({ ok: false, error_code: 403 })));
    await expect(denied.send('-100123',message)).rejects.toMatchObject({ outcome: 'failed', code: 'telegram_rejected_403' });
  });
});
