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
  const config = z.object({ channelId: z.string(), inviteUrl: z.string() }).parse(await state('telegram_destination'));
  if (config.channelId !== publication.destination_id) throw new Error('Reconciliation destination changed');
  const attempts = (await db.query<SendWindow>(`SELECT dispatched_at,response_metadata FROM request_attempts
    WHERE publication_id=$1 AND operation='send' AND status IN ('running','unknown') ORDER BY dispatched_at`, [publication.id])).rows;
  const windows = attempts.map(attempt => {
    const parsed = fingerprintSchema.safeParse(attempt.response_metadata);
    if (!parsed.success) throw new ReconciliationReviewError('Legacy send requires review');
    return { fingerprint: parsed.data.fingerprint, start: attempt.dispatched_at.getTime() - BEFORE_MS,
      end: attempt.dispatched_at.getTime() + AFTER_MS };
  });
  if (!windows.length) throw new ReconciliationReviewError('Send attempt missing');
  const others = (await db.query<{ message_id: string | null; dispatched_at: Date | null; response_metadata: unknown }>(`
    SELECT p.message_id,a.dispatched_at,a.response_metadata FROM publications p
    LEFT JOIN request_attempts a ON a.publication_id=p.id AND a.operation='send'
    WHERE p.destination_id=$1 AND p.id<>$2 AND (a.id IS NULL OR a.status IN ('running','unknown','succeeded'))`, [publication.destination_id,publication.id])).rows;
  for (const other of others) {
    const parsed = fingerprintSchema.safeParse(other.response_metadata);
    if (parsed.success && other.dispatched_at && windows.some(window => window.fingerprint === parsed.data.fingerprint &&
        other.dispatched_at !== null && other.dispatched_at.getTime() + AFTER_MS >= window.start && other.dispatched_at.getTime() - BEFORE_MS <= window.end)) {
      throw new ReconciliationReviewError('Overlapping identical sends require review');
    }
  }
  const known = new Set(others.flatMap(other => other.message_id ? [other.message_id] : []));
  return withUserClient(async client => {
    const result = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash(config.inviteUrl) }));
    if (!(result instanceof Api.ChatInviteAlready || result instanceof Api.ChatInvitePeek) ||
        !(result.chat instanceof Api.Channel) || utils.getPeerId(result.chat) !== publication.destination_id) {
      throw new Error('Reconciliation channel unavailable');
    }
    const earliest = Math.min(...windows.map(window => window.start));
    let found: string | null = null;
    // GetHistory is read-only: no joins, read acknowledgements or view increments.
    for await (const message of client.iterMessages(result.chat, {})) {
      if (message.date * 1000 < earliest) break;
      if (!(message instanceof Api.Message) || utils.getPeerId(message.peerId) !== publication.destination_id || known.has(String(message.id))) continue;
      // Edited/forwarded content cannot establish the original send outcome.
      if (message.editDate || message.fwdFrom) continue;
      const links = (message.entities ?? []).flatMap(entity => entity instanceof Api.MessageEntityTextUrl
        ? [{ offset: entity.offset, length: entity.length, url: entity.url }] : []);
      const fingerprint = contentFingerprint(message.message, links);
      if (!windows.some(window => message.date * 1000 >= window.start && message.date * 1000 <= window.end && fingerprint === window.fingerprint)) continue;
      if (found && found !== String(message.id)) throw new ReconciliationReviewError('Multiple publication matches require review');
      found = String(message.id);
    }
    return found;
  });
}
