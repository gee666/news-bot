import { describe, expect, it, vi } from 'vitest';
import { BotApi, MAX_ALBUM_MEDIA } from './bot-api.js';
import { renderCaption } from './caption.js';

const caption = renderCaption({ headline: 'News <headline>', score: 8, details: 'Body '.repeat(500), detailsKind: 'summary', sources: [] });
const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from([0, 1, 254, 255]) };
const video = { type: 'video' as const, mimeType: 'video/mp4', data: Buffer.from('original video bytes') };
const document = { type: 'image' as const, mimeType: 'image/webp', data: Buffer.from('original webp bytes') };
const result = (id: number) => ({ message_id: id, chat: { id: -100123 } });
const response = (value: unknown) => new Response(JSON.stringify({ ok: true, result: value }));

describe('caption-first Bot API publication', () => {
  it.each([['sendPhoto', image, 'photo'], ['sendVideo', video, 'video'], ['sendDocument', document, 'document']] as const)(
    'makes one %s request carrying the bounded caption and unchanged bytes', async (method, item, field) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(result(10)));
      expect(await new BotApi('123:synthetic', fetcher).sendAlbum('-100123', caption, [item])).toEqual(['10']);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]?.[0]).toContain(`/${method}`);
      const form = fetcher.mock.calls[0]?.[1]?.body;
      if (!(form instanceof FormData)) throw new Error('Missing multipart body');
      expect(form.get('caption')).toBe(caption.text);
      expect(caption.plainText.length).toBeLessThanOrEqual(1024);
      expect(form.get('parse_mode')).toBe('HTML');
      expect(form.get('reply_parameters')).toBeNull();
      const blob = form.get(field);
      if (!(blob instanceof Blob)) throw new Error('Missing original media');
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(item.data);
      expect(blob.type).toBe(item.mimeType);
    });
  it('sends ten items in one group, only the first carries the caption', async () => {
    const media = Array.from({ length: MAX_ALBUM_MEDIA }, (_, index) => index % 2 ? video : image);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(media.map((_, index) => result(10 + index))));
    expect(await new BotApi('123:synthetic', fetcher).sendAlbum('-100123', caption, media)).toHaveLength(10);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toContain('/sendMediaGroup');
    const form = fetcher.mock.calls[0]?.[1]?.body;
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    const entries = JSON.parse(String(form.get('media')));
    expect(entries[0]).toEqual({ type: 'photo', media: 'attach://file0', caption: caption.text, parse_mode: 'HTML' });
    expect(entries.slice(1).every((entry: object) => !('caption' in entry))).toBe(true);
    expect(form.get('reply_parameters')).toBeNull();
    for (const [index, item] of media.entries()) {
      const blob = form.get(`file${index}`);
      if (!(blob instanceof Blob)) throw new Error('Missing original media');
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(item.data);
    }
  });
  it('uses one document-only album without transcoding', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response([result(10), result(11)]));
    await new BotApi('123:synthetic', fetcher).sendAlbum('-100123', caption, [document, document]);
    const form = fetcher.mock.calls[0]?.[1]?.body;
    if (!(form instanceof FormData)) throw new Error('Missing multipart body');
    expect(JSON.parse(String(form.get('media')))).toMatchObject([
      { type: 'document', caption: caption.text, disable_content_type_detection: true },
      { type: 'document', disable_content_type_detection: true },
    ]);
  });
  it('rejects eleven items, mixed document/native media and oversized captions without network calls', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = new BotApi('123:synthetic', fetcher);
    for (const media of [[], Array.from({ length: 11 }, () => image), [document, image]]) {
      await expect(api.sendAlbum('-100123', caption, media)).rejects.toMatchObject({ outcome: 'failed' });
    }
    await expect(api.sendAlbum('-100123', { ...caption, plainText: 'x'.repeat(1025) }, [image])).rejects.toMatchObject({ outcome: 'failed' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('treats partial, duplicate and wrong-destination response IDs as unknown', async () => {
    for (const value of [[result(10)], [result(10), result(10)], [result(10), { ...result(11), chat: { id: -100456 } }]]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(value));
      await expect(new BotApi('123:synthetic', fetcher).sendAlbum('-100123', caption, [image, video])).rejects.toMatchObject({ outcome: 'unknown' });
    }
  });
  it('edits the canonical caption, accepts not-modified and never edits message text', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(result(10)));
    await new BotApi('123:synthetic', fetcher).editCaption('-100123', '10', caption);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toContain('/editMessageCaption');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ chat_id: '-100123', message_id: 10, caption: caption.text, parse_mode: 'HTML' });
    fetcher.mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' })));
    await expect(new BotApi('123:synthetic', fetcher).editCaption('-100123', '10', caption)).resolves.toBeUndefined();
  });
});
