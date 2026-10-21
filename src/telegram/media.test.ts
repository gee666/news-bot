import { Api } from 'telegram';
import { parseID } from 'telegram/Utils.js';
import { describe, expect, it, vi } from 'vitest';
import { messageItem, TelegramHistory, type HistoryClient } from './history.js';
import { collectSource, type CollectionStore } from './collector.js';
import { messageMedia } from './media.js';
import { source } from './test-fixtures.js';

function id(value = '1234') {
  const parsed = parseID(value);
  if (!parsed) throw new Error('Invalid fixture ID');
  return parsed;
}
const cutoff = new Date('2025-09-29T12:00:00Z');
const since = new Date('2025-09-27T12:00:00Z');
function photo(): Api.MessageMediaPhoto {
  return new Api.MessageMediaPhoto({ photo: new Api.Photo({ id: id(), accessHash: id('5678'),
    fileReference: Buffer.alloc(0), date: 1759143600, sizes: [], dcId: 2 }) });
}
function document(mimeType: string, attributes: Api.TypeDocumentAttribute[] = []): Api.MessageMediaDocument {
  return new Api.MessageMediaDocument({ document: new Api.Document({ id: id(), accessHash: id('5678'),
    fileReference: Buffer.alloc(0), date: 1759143600, mimeType, size: id('100'), dcId: 2, attributes }) });
}
function message(messageId: number, text: string, media?: Api.TypeMessageMedia, groupedId?: string): Api.Message {
  return new Api.Message({ id: messageId, message: text, date: cutoff.getTime() / 1000 - 60,
    peerId: new Api.PeerChannel({ channelId: id() }), ...(media ? { media } : {}),
    ...(groupedId ? { groupedId: id(groupedId) } : {}) });
}
function reader(messages: Api.Message[]): TelegramHistory {
  const iterMessages = vi.fn<HistoryClient['iterMessages']>().mockImplementation(async function* () { yield* messages; });
  return new TelegramHistory({ iterMessages });
}

describe('Telegram media references', () => {
  it('records public and private photos using stable marked peer IDs, not usernames or expiring file references', () => {
    const expected = [{ type: 'image', telegramMessageId: 42, telegramPeer: '-1001234' }];
    expect(messageItem(message(42, 'caption', photo()), source())?.metadata.media).toEqual(expected);
    expect(messageItem(message(42, 'caption', photo()), source({ metadata: { username: 'public', channelId: '1234' } }))?.metadata.media)
      .toEqual(expected);
  });

  it('recognizes videos by MIME or video attributes and images sent as documents', () => {
    const video = new Api.DocumentAttributeVideo({ duration: 3, w: 1280, h: 720 });
    for (const media of [document('video/mp4'), document('application/octet-stream', [video])]) {
      expect(messageMedia(message(42, 'caption', media), source())[0]?.type).toBe('video');
    }
    expect(messageMedia(message(42, 'caption', document('image/png')), source())[0]?.type).toBe('image');
  });

  it('does not classify empty photos, audio, PDFs, stickers or web previews as content media', () => {
    const sticker = new Api.DocumentAttributeSticker({ alt: 'sticker', stickerset: new Api.InputStickerSetEmpty() });
    for (const media of [new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: id() }) }),
      document('audio/ogg'), document('application/pdf'), document('image/webp', [sticker]),
      new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: id() }) })]) {
      expect(messageMedia(message(42, 'caption', media), source())).toEqual([]);
    }
    expect(messageItem(message(42, 'text only'), source())?.metadata.media).toEqual([]);
  });

  it.each([true, false])('attaches all album references to its caption when caption is newest=%s', async newest => {
    const groupedId = '9007199254740993';
    const messages = [message(44, newest ? 'album caption' : '', photo(), groupedId),
      message(43, '', document('video/mp4'), groupedId), message(42, newest ? '' : 'album caption', photo(), groupedId)];
    const commitSource = vi.fn<CollectionStore['commitSource']>().mockResolvedValue(1);
    await collectSource(reader(messages), { commitSource }, 'batch', source(), cutoff);
    const items = commitSource.mock.calls[0]?.[2];
    expect(items).toHaveLength(1);
    expect(items?.[0]?.metadata.media).toEqual([
      { type: 'image', telegramMessageId: 42, telegramPeer: '-1001234', groupedId },
      { type: 'video', telegramMessageId: 43, telegramPeer: '-1001234', groupedId },
      { type: 'image', telegramMessageId: 44, telegramPeer: '-1001234', groupedId },
    ]);
    expect(commitSource.mock.calls[0]?.[3].lastMessageId).toBe(44);
  });

  it('does not mix adjacent albums, plain posts, or siblings edited beyond the cutoff', async () => {
    const future = message(46, '', photo(), '100');
    future.editDate = cutoff.getTime() / 1000 + 1;
    const entries = [];
    for await (const entry of reader([future, message(45, 'first', photo(), '100'),
      message(44, 'second', document('video/mp4'), '99'), message(43, 'plain')]).recent(source(), since, cutoff)) entries.push(entry);
    expect(entries.find(entry => entry.sequence === 45)?.item?.metadata.media)
      .toEqual([{ type: 'image', telegramMessageId: 45, telegramPeer: '-1001234', groupedId: '100' }]);
    expect(entries.find(entry => entry.sequence === 44)?.item?.metadata.media)
      .toEqual([{ type: 'video', telegramMessageId: 44, telegramPeer: '-1001234', groupedId: '99' }]);
    expect(entries.at(-1)?.item?.metadata.media).toEqual([]);
  });
});
