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
interface SendWindow { dispatched_at: Date; response_metadata: unknown }
const BEFORE_MS = 30_000;
const AFTER_MS = 60_000;
const timeoutSchema = z.object({ requestTimeoutMs: z.number().int().min(1000).max(900_000) });
function sendWindowAfter(metadata: unknown): number {
  return timeoutSchema.parse(metadata).requestTimeoutMs + AFTER_MS;
}

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
  const config = z.object({ channelId: z.string(), inviteUrl: z.string() }).parse(await state('telegram_destination'));
  if (config.channelId !== publication.destination_id) throw new Error('Reconciliation destination changed');
  const attempts = (await db.query<SendWindow>(`SELECT dispatched_at,response_metadata FROM request_attempts
    WHERE publication_id=$1 AND operation='send' AND status IN ('running','unknown') ORDER BY dispatched_at`, [publication.id])).rows;
  const windows = attempts.map(attempt => {
    const parsed = fingerprintSchema.safeParse(attempt.response_metadata);
    if (!parsed.success) throw new ReconciliationReviewError('Legacy send requires review');
    return { fingerprint: parsed.data.fingerprint, start: attempt.dispatched_at.getTime() - BEFORE_MS,
      end: attempt.dispatched_at.getTime() + sendWindowAfter(attempt.response_metadata) };
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
        other.dispatched_at !== null && other.dispatched_at.getTime() + sendWindowAfter(other.response_metadata) >= window.start && other.dispatched_at.getTime() - BEFORE_MS <= window.end)) {
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
    // GetHistory is read-only: no joins, read acknowledgements or view increments.
    for await (const message of client.iterMessages(result.chat, { offsetDate: Math.floor((latest + AFTER_MS) / 1000) + 1 })) {
      if (!(message instanceof Api.Message) || utils.getPeerId(message.peerId) !== publication.destination_id) continue;
      if (message.date * 1000 < earliest) break;
      if (known.has(String(message.id)) || !windows.some(window => message.date*1000 >= window.start && message.date*1000 <= window.end)) continue;
      // A caption can equal the canonical text, but cannot complete its send.
      if (message.media && !(message.media instanceof Api.MessageMediaEmpty)) continue;
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
    return String(found.id);
  });
}
