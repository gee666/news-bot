import { createHash } from 'node:crypto';
import { Api, utils } from 'telegram';
import { z } from 'zod';
import { db } from '../db.js';
import { withUserClient } from '../telegram/client.js';
import { inviteHash } from '../telegram/discovery.js';
import type { RenderedMessage, SourceLink } from './render.js';
import { state, type Publication } from './store.js';

export function contentFingerprint(plainText: string, links: SourceLink[]): string {
  return createHash('sha256').update(JSON.stringify({ plainText, links })).digest('hex');
}
export function sendMetadata(message: RenderedMessage): { fingerprint: string } {
  return { fingerprint: contentFingerprint(message.plainText, message.links) };
}
const fingerprintSchema = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) });
export class ReconciliationReviewError extends Error {}
export interface AlbumReceipt { messageId: string; messageIds: string[] }
const albumRequestSchema = z.object({ deliveryKind: z.literal('album'), itemIds: z.array(z.string()).min(1).max(10),
  uploadTypes: z.array(z.enum(['photo','video','document'])).min(1).max(10), botId: z.string() });
interface SendWindow { dispatched_at: Date; response_metadata: unknown }
// Bot API HTTP timeout is 30 seconds. Allow clock skew, never scan an unbounded publication lifetime.
const BEFORE_MS = 30_000;
const AFTER_MS = 90_000;

export async function readMessageFingerprint(publication: Publication): Promise<string | null> {
  if (!publication.message_id) return null;
  const config = z.object({ channelId: z.string(), inviteUrl: z.string() }).parse(await state('telegram_destination'));
  if (config.channelId !== publication.destination_id) throw new ReconciliationReviewError('Destination changed');
  return withUserClient(async client => {
    const result = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash(config.inviteUrl) }));
    if (!(result instanceof Api.ChatInviteAlready || result instanceof Api.ChatInvitePeek) || !(result.chat instanceof Api.Channel)
      || utils.getPeerId(result.chat) !== publication.destination_id) throw new ReconciliationReviewError('Channel unavailable');
    const messages = await client.getMessages(result.chat,{ ids: [Number(publication.message_id)] });
    const message = messages.find(value => value && String(value.id) === publication.message_id);
    if (!(message instanceof Api.Message) || utils.getPeerId(message.peerId) !== publication.destination_id) return null;
    const links = (message.entities ?? []).flatMap(entity => entity instanceof Api.MessageEntityTextUrl
      ? [{ offset: entity.offset, length: entity.length, url: entity.url }] : []);
    return contentFingerprint(message.message,links);
  });
}

export async function readSentMessage(publication: Publication): Promise<string | null> {
  return (await readSentPublication(publication))?.messageId ?? null;
}

export async function readSentPublication(publication: Publication): Promise<AlbumReceipt | null> {
  const config = z.object({ channelId: z.string(), inviteUrl: z.string() }).parse(await state('telegram_destination'));
  if (config.channelId !== publication.destination_id) throw new Error('Reconciliation destination changed');
  const attempts = (await db.query<SendWindow>(`SELECT dispatched_at,response_metadata FROM request_attempts
    WHERE publication_id=$1 AND operation='send' AND status IN ('running','unknown') ORDER BY dispatched_at`, [publication.id])).rows;
  const windows = attempts.map(attempt => {
    const parsed = fingerprintSchema.safeParse(attempt.response_metadata);
    if (!parsed.success) throw new ReconciliationReviewError('Legacy send requires review');
    const album = publication.delivery_kind === 'album' ? albumRequestSchema.safeParse(attempt.response_metadata) : null;
    if (album && (!album.success || album.data.botId !== publication.bot_id || album.data.itemIds.length !== album.data.uploadTypes.length)) {
      throw new ReconciliationReviewError('Album request metadata missing');
    }
    return { album: album?.success ? album.data : null, fingerprint: parsed.data.fingerprint, start: attempt.dispatched_at.getTime() - BEFORE_MS,
      end: attempt.dispatched_at.getTime() + AFTER_MS };
  });
  if (!windows.length) throw new ReconciliationReviewError('Send attempt missing');
  const others = (await db.query<{ message_id: string | null; media_ids: string[]; dispatched_at: Date | null; response_metadata: unknown }>(`
    SELECT p.message_id,a.dispatched_at,a.response_metadata,ARRAY(SELECT i.message_id FROM publication_media_items i
      JOIN publication_media_batches b ON b.id=i.batch_id WHERE b.publication_id=p.id AND i.message_id IS NOT NULL) AS media_ids FROM publications p
    LEFT JOIN request_attempts a ON a.publication_id=p.id AND a.operation='send'
    WHERE p.destination_id=$1 AND p.id<>$2 AND (a.id IS NULL OR a.status IN ('running','unknown','succeeded'))`, [publication.destination_id,publication.id])).rows;
  for (const other of others) {
    const parsed = fingerprintSchema.safeParse(other.response_metadata);
    if (parsed.success && other.dispatched_at && windows.some(window => window.fingerprint === parsed.data.fingerprint &&
        other.dispatched_at !== null && other.dispatched_at.getTime() + AFTER_MS >= window.start && other.dispatched_at.getTime() - BEFORE_MS <= window.end)) {
      throw new ReconciliationReviewError('Overlapping identical sends require review');
    }
  }
  const known = new Set(others.flatMap(other => [...(other.message_id ? [other.message_id] : []), ...(other.media_ids ?? [])]));
  return withUserClient(async client => {
    const result = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash(config.inviteUrl) }));
    if (!(result instanceof Api.ChatInviteAlready || result instanceof Api.ChatInvitePeek) ||
        !(result.chat instanceof Api.Channel) || utils.getPeerId(result.chat) !== publication.destination_id) {
      throw new Error('Reconciliation channel unavailable');
    }
    const earliest = Math.min(...windows.map(window => window.start));
    const latest = Math.max(...windows.map(window => window.end));
    let found: Api.Message | null = null;
    const scanned: Api.Message[] = [];
    // GetHistory is read-only: no joins, read acknowledgements or view increments.
    for await (const message of client.iterMessages(result.chat, { offsetDate: Math.floor((latest + AFTER_MS) / 1000) + 1 })) {
      if (!(message instanceof Api.Message) || utils.getPeerId(message.peerId) !== publication.destination_id) continue;
      // Keep every observed sibling before candidate filtering. A known ID or a boundary sibling
      // must invalidate the group, not disappear and leave a falsely complete subset.
      scanned.push(message);
      if (message.date * 1000 < earliest) break;
      if (known.has(String(message.id)) || !windows.some(window => message.date*1000 >= window.start && message.date*1000 <= window.end)) continue;
      // Edited/forwarded content cannot establish the original send outcome.
      if (message.editDate || message.fwdFrom) continue;
      const links = (message.entities ?? []).flatMap(entity => entity instanceof Api.MessageEntityTextUrl
        ? [{ offset: entity.offset, length: entity.length, url: entity.url }] : []);
      const fingerprint = contentFingerprint(message.message, links);
      if (!windows.some(window => message.date * 1000 >= window.start && message.date * 1000 <= window.end && fingerprint === window.fingerprint)) continue;
      if (found && found.id !== message.id) throw new ReconciliationReviewError('Multiple publication matches require review');
      found = message;
    }
    if (!found) return null;
    if (publication.delivery_kind !== 'album') return { messageId: String(found.id), messageIds: [String(found.id)] };
    const window = windows.find(window => window.album && found && found.date * 1000 >= window.start && found.date * 1000 <= window.end
      && contentFingerprint(found.message, (found.entities ?? []).flatMap(entity => entity instanceof Api.MessageEntityTextUrl
        ? [{ offset: entity.offset, length: entity.length, url: entity.url }] : [])) === window.fingerprint);
    if (!window?.album) throw new ReconciliationReviewError('Album request metadata missing');
    const expected = window.album.uploadTypes;
    const group = found.groupedId ? scanned.filter(item => item.groupedId?.toString() === found?.groupedId?.toString()) : [found];
    group.sort((a,b) => a.id-b.id);
    if (group.length !== expected.length || group[0]?.id !== found.id || (expected.length > 1 ? !found.groupedId : Boolean(found.groupedId))
      || group.some((item,index) => known.has(String(item.id)) || item.editDate || item.fwdFrom || item.date*1000 < window.start || item.date*1000 > window.end
        || index > 0 && item.message !== ''
        || (expected[index] === 'photo' ? !(item.media instanceof Api.MessageMediaPhoto) : !(item.media instanceof Api.MessageMediaDocument))
        || expected[index] === 'video' && (!(item.media instanceof Api.MessageMediaDocument)
          || !(item.media.document instanceof Api.Document) || item.media.document.mimeType !== 'video/mp4'
          || !item.media.document.attributes.some(attribute => attribute instanceof Api.DocumentAttributeVideo)))) {
      throw new ReconciliationReviewError('Incomplete or changed album requires review');
    }
    return { messageId: String(found.id), messageIds: group.map(item => String(item.id)) };
  });
}
