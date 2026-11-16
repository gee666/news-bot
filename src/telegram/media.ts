import { Api } from 'telegram';
import type { TelegramSource } from './types.js';

export interface TelegramMedia {
  type: 'image' | 'video';
  telegramMessageId: number;
  telegramPeer: string;
  groupedId?: string;
  telegramMediaId?: string;
}

/** Stable attachment identity, never expiring file references or access credentials. */
export function telegramMediaIdentity(media: Api.TypeMessageMedia | undefined): string | undefined {
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) return `photo:${media.photo.id.toString()}`;
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) return `document:${media.document.id.toString()}`;
  return undefined;
}

export function messageMedia(message: Api.Message, source: TelegramSource): TelegramMedia[] {
  if (!Number.isSafeInteger(message.id) || message.id < 1 || !/^-100\d+$/u.test(source.externalId)) return [];
  const media = message.media;
  let type: TelegramMedia['type'] | null = null;
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) type = 'image';
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const document = media.document;
    // Stickers and custom emoji are not post images, even when their MIME type is image/*.
    if (document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeSticker
      || attribute instanceof Api.DocumentAttributeCustomEmoji)) return [];
    if (/^video\//iu.test(document.mimeType)
      || document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeVideo)) type = 'video';
    else if (/^image\//iu.test(document.mimeType)) type = 'image';
  }
  const telegramMediaId = telegramMediaIdentity(media);
  return type && telegramMediaId ? [{ type, telegramMessageId: message.id, telegramPeer: source.externalId, telegramMediaId,
    ...(message.groupedId ? { groupedId: message.groupedId.toString() } : {}) }] : [];
}
