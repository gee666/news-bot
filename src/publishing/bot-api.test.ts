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

describe('Telegram multipart attachments', () => {
  const image = { type: 'image' as const, data: Buffer.from('image'), mimeType: 'image/png' };
  const video = { type: 'video' as const, data: Buffer.from('video'), mimeType: 'video/mp4' };
  it.each([['sendPhoto', image, 'photo'], ['sendVideo', video, 'video']] as const)('uploads a single %s replying to the canonical text', async (method, media, field) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: { message_id: 10, chat: { id: -100123 } } }));
    expect(await new BotApi(token, fetcher).sendMedia('-100123', '9', [media])).toEqual(['10']);
    expect(fetcher.mock.calls[0]?.[0]).toContain(`/${method}`);
    const form = fetcher.mock.calls[0]?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    const upload = form.get(field);
    expect(upload).toBeInstanceOf(Blob);
    if (!(upload instanceof Blob)) throw new Error('Missing original upload');
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(media.data);
    expect(upload.type).toBe(media.mimeType);
    expect(form.get('caption')).toBeNull();
    expect(JSON.parse(String(form.get('reply_parameters')))).toEqual({ message_id: 9, allow_sending_without_reply: false });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });
  it('uploads mixed albums with attach references, no captions or dropped text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: [
      { message_id: 10, chat: { id: -100123 } }, { message_id: 11, chat: { id: -100123 } },
    ] }));
    expect(await new BotApi(token, fetcher).sendMedia('-100123', '9', [image, video])).toEqual(['10', '11']);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/sendMediaGroup');
    const form = fetcher.mock.calls[0]?.[1]?.body;
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    expect(JSON.parse(String(form.get('media')))).toEqual([
      { type: 'photo', media: 'attach://file0' }, { type: 'video', media: 'attach://file1' },
    ]);
    expect(form.get('file0')).toBeInstanceOf(Blob);
    expect(form.get('file1')).toBeInstanceOf(Blob);
  });
  it.each([
    [image], [image, video], [{ type:'video' as const,mimeType:'video/webm',data:Buffer.from('original WEBM') }],
  ])('uploads standalone caption-free media before a canonical text post: %j', async (...items) => {
    const result = items.map((_,index) => ({ message_id:10+index,chat:{ id:-100123 } }));
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok:true,result:items.length === 1 ? result[0] : result }));
    await new BotApi(token,fetcher).sendMedia('-100123',undefined,items);
    const form = fetcher.mock.calls[0]?.[1]?.body;
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    expect(form.get('reply_parameters')).toBeNull(); expect(form.get('caption')).toBeNull(); expect(form.get('parse_mode')).toBeNull();
    expect(String(form.get('media'))).not.toContain('caption');
    const files = [...form.values()].filter(value => value instanceof Blob);
    expect(files).toHaveLength(items.length);
    for (const [index,file] of files.entries()) {
      if (!(file instanceof Blob)) throw new Error('Missing original media');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(items[index]?.data);
    }
  });
  it('rejects oversized batches before touching the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BotApi(token, fetcher).sendMedia('-100123', '9', Array.from({ length: 11 }, () => image)))
      .rejects.toMatchObject({ outcome: 'failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('treats partial album responses, wrong destinations and duplicate ids as unknown', async () => {
    for (const result of [[], [{ message_id: 10, chat: { id: -100124 } }, { message_id: 11, chat: { id: -100124 } }],
      [{ message_id: 10, chat: { id: -100123 } }, { message_id: 10, chat: { id: -100123 } }]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result }));
      await expect(new BotApi(token, fetcher).sendMedia('-100123', '9', [image, video])).rejects.toMatchObject({ outcome: 'unknown' });
    }
  });
});


describe('original-format document uploads', () => {
  it.each([
    ['video', 'video/webm', 'webm'], ['video', 'video/quicktime', 'mov'],
    ['image', 'image/gif', 'gif'], ['image', 'image/webp', 'webp'],
  ] as const)('sends original %s %s bytes as a document, never relabels as MP4/JPEG', async (type, mimeType, extension) => {
    const data = Buffer.from([0, 1, 255, 128, 13, 10, 0, 42]);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: { message_id: 10, chat: { id: -100123 } } }));
    await new BotApi(token, fetcher).sendMedia('-100123', '9', [{ type, mimeType, data }]);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/sendDocument');
    const form = fetcher.mock.calls[0]?.[1]?.body;
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    const upload = form.get('document');
    if (!(upload instanceof Blob)) throw new Error('Missing original document');
    expect(Buffer.from(await upload.arrayBuffer())).toEqual(data);
    expect(upload.type).toBe(mimeType);
    expect(upload).toMatchObject({ name: `document.${extension}` });
    expect(form.get('photo')).toBeNull();
    expect(form.get('video')).toBeNull();
    expect(form.get('disable_content_type_detection')).toBe('true');
  });
  it('groups original document formats without changing any payload bytes', async () => {
    const media = [
      { type: 'video' as const, mimeType: 'video/webm', data: Buffer.from([0, 255, 99]) },
      { type: 'image' as const, mimeType: 'image/gif', data: Buffer.from([71, 73, 70, 0, 128]) },
    ];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, result: [
      { message_id: 10, chat: { id: -100123 } }, { message_id: 11, chat: { id: -100123 } },
    ] }));
    await new BotApi(token, fetcher).sendMedia('-100123', '9', media);
    const form = fetcher.mock.calls[0]?.[1]?.body;
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    expect(JSON.parse(String(form.get('media')))).toEqual([
      { type: 'document', media: 'attach://file0', disable_content_type_detection: true },
      { type: 'document', media: 'attach://file1', disable_content_type_detection: true },
    ]);
    for (const [index, item] of media.entries()) {
      const upload = form.get(`file${index}`);
      if (!(upload instanceof Blob)) throw new Error('Missing original document');
      expect(Buffer.from(await upload.arrayBuffer())).toEqual(item.data);
      expect(upload.type).toBe(item.mimeType);
    }
  });
  it('rejects mixed document/native albums before any Telegram request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new BotApi(token, fetcher).sendMedia('-100123', '9', [
      { type: 'video', mimeType: 'video/webm', data: Buffer.from('webm') },
      { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpeg') },
    ])).rejects.toMatchObject({ code: 'telegram_media_batch_invalid', outcome: 'failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
