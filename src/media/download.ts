import { Api } from 'telegram';
import { parseID } from 'telegram/Utils.js';
import { z } from 'zod';
import { withUserClient } from '../telegram/client.js';
import { fetchPublicMedia } from '../pipeline/research-fetch.js';
import type { MediaCandidate } from './comparison.js';

export const mediaDescriptor = z.object({ type: z.enum(['image', 'video']), url: z.string().optional(),
  telegramMessageId: z.number().int().positive().optional() });
export type MediaDescriptor = z.infer<typeof mediaDescriptor>;
export interface MediaSource { metadata: Record<string, unknown> }

export async function downloadMedia(descriptor: MediaDescriptor, source: MediaSource): Promise<MediaCandidate> {
  const maxBytes = descriptor.type === 'image' ? 9_000_000 : 45_000_000;
  if (descriptor.url) {
    const response = await fetchPublicMedia(descriptor.url, maxBytes);
    if (response.status !== 200 || !response.contentType.startsWith(descriptor.type === 'image' ? 'image/' : 'video/')) {
      throw new Error('Media source returned invalid content');
    }
    return { type: descriptor.type, data: response.data, mimeType: response.contentType };
  }
  if (!descriptor.telegramMessageId) throw new Error('Media descriptor has no download location');
  const channel = z.object({ channelId: z.string().regex(/^\d+$/u), accessHash: z.string().regex(/^-?\d+$/u) }).parse(source.metadata);
  const channelId = parseID(channel.channelId); const accessHash = parseID(channel.accessHash);
  if (!channelId || !accessHash) throw new Error('Invalid Telegram media peer');
  return withUserClient(async client => {
    const peer = new Api.InputPeerChannel({ channelId, accessHash });
    const messages = await client.getMessages(peer, { ids: [descriptor.telegramMessageId ?? 0] });
    const message = messages[0];
    if (!message?.media) throw new Error('Telegram source media is no longer available');
    if (message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document
      && Number(message.media.document.size.toString()) > maxBytes) throw new Error('Media exceeds upload size limit');
    const data = await client.downloadMedia(message, { progressCallback: async (received, total) => {
      if (Number(received.toString()) > maxBytes || Number(total.toString()) > maxBytes) throw new Error('Media exceeds upload size limit');
    } });
    if (!Buffer.isBuffer(data) || data.length > maxBytes) throw new Error('Media download failed or exceeds upload size limit');
    const mimeType = message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document
      ? message.media.document.mimeType : 'image/jpeg';
    return { type: descriptor.type, data, mimeType };
  });
}
