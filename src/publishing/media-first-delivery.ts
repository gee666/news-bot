import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { releaseStoryMedia } from '../media/story-media.js';
import { BotApi, BotError, mediaUploadType, telegramTimeouts, type PublicationMedia } from './bot-api.js';
import { publicationAdmission, recordAdmissionDenial, type DeliveryAuthorization } from './freshness.js';
import { destinationBlocked, reserveDestination } from './destination-order.js';
import { settleExpiredPublications, rateLimited, type Publication } from './store.js';

interface Batch { id: string; batch_number: number; status: string; attempt_count: number; next_retry_at: Date | null }
interface Item { id: string; type: PublicationMedia['type']; mime_type: string; digest: string; data: Buffer | null; expires_at: Date }

/** Caller holds the global digest lease. Reservations last until a text receipt or terminal stop. */
export async function deliverMediaFirst(publication: Publication, api: BotApi, settings: AppSettings,
  authorization: DeliveryAuthorization): Promise<boolean> {
  if (publication.delivery_kind !== 'media_first' || publication.status !== 'prepared' || publication.message_id) return false;
  const botId = String((await api.identity()).id);
  if (publication.bot_id && publication.bot_id !== botId) return false;
  const batches = (await db.query<Batch>(`SELECT * FROM publication_media_batches WHERE publication_id=$1 ORDER BY batch_number`, [publication.id])).rows;
  const count = (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM publication_media_items i
    JOIN publication_media_batches b ON b.id=i.batch_id WHERE b.publication_id=$1`, [publication.id])).rows[0]?.count ?? 0;
  if (count > 10) return false;
  for (const batch of batches) {
    if ((await settleExpiredPublications(publication.destination_id,publication.id)).some(item => item.kind === 'send')) return false;
    // An unknown upload may already exist. Never retry it or invent a receipt.
    if (['sent','unknown','failed'].includes(batch.status)) continue;
    if (!['prepared','retryable'].includes(batch.status)) return false;
    if (batch.attempt_count >= settings.requestMaxAttempts) {
      await failBatch(batch, 'publication_media_retry_exhausted');
      continue;
    }
    const items = (await db.query<Item>('SELECT * FROM publication_media_items WHERE batch_id=$1 ORDER BY ordinal', [batch.id])).rows;
    if (!items.length || items.some(item => !item.data?.length || item.expires_at.getTime() <= Date.now())) {
      await failBatch(batch, 'publication_media_expired');
      continue;
    }
    if (batch.next_retry_at && batch.next_retry_at > new Date() || await rateLimited()) return false;
    const media: PublicationMedia[] = [];
    for (const item of items) {
      if (!item.data) return false;
      media.push({ type: item.type, mimeType: item.mime_type, data: item.data });
    }
    const attemptId = await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
      if (await destinationBlocked(publication.destination_id, publication.id, client)) return null;
      const admission = await publicationAdmission(client, publication, settings, 'send', authorization, botId);
      if (!admission.allowed) {
        await recordAdmissionDenial(client, publication, 'send', admission.reason);
        return null;
      }
      const frozen = (await client.query<Item>('SELECT * FROM publication_media_items WHERE batch_id=$1 ORDER BY ordinal FOR UPDATE', [batch.id])).rows;
      if (frozen.length !== items.length || frozen.some((item,index) => item.id !== items[index]?.id
        || item.digest !== items[index]?.digest || item.type !== items[index]?.type || item.mime_type !== items[index]?.mime_type || !item.data?.equals(items[index]?.data ?? Buffer.alloc(0))
        || item.expires_at.getTime() <= Date.now())) return null;
      const claimed = await client.query(`UPDATE publication_media_batches SET status='running',attempt_count=attempt_count+1,
        dispatched_at=now(),error_code=NULL,next_retry_at=NULL WHERE id=$1 AND status IN ('prepared','retryable')
        AND (next_retry_at IS NULL OR next_retry_at<=now())
        AND NOT EXISTS(SELECT 1 FROM publication_media_items WHERE batch_id=$1 AND (data IS NULL OR expires_at<=now())) RETURNING id`, [batch.id]);
      if (!claimed.rows.length) return null;
      // History locking serializes reservations. Failure here must roll back the batch claim.
      if (!await reserveDestination(publication.destination_id, publication.id, client)) throw new Error('Destination reservation changed');
      const attempt = (await client.query<{ id: string }>(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
        SELECT $1,'telegram-bot',$2,coalesce(max(attempt_number),0)+1,'running',$3 FROM request_attempts WHERE publication_id=$1 RETURNING id`,
      [publication.id, `send_media:${batch.batch_number}`, JSON.stringify({ deliveryKind: 'media_first', botId,
        snapshotId: publication.snapshot_id, itemIds: items.map(item => item.id), mediaDigests: items.map(item => item.digest),
        uploadTypes: media.map(mediaUploadType), requestTimeoutMs: telegramTimeouts().uploadMs })])).rows[0];
      await client.query('UPDATE publications SET bot_id=coalesce(bot_id,$2),updated_at=now() WHERE id=$1', [publication.id,botId]);
      return attempt?.id ?? null;
    });
    if (!attemptId) return false;
    // Subsequent batches and the canonical request must pass admission with the persisted identity.
    publication = { ...publication, bot_id: botId };
    let ids: string[];
    try {
      ids = await api.sendMedia(publication.destination_id, undefined, media);
      if (ids.length !== items.length || new Set(ids).size !== items.length || ids.some(id => !/^[1-9]\d*$/u.test(id))) {
        throw new BotError('telegram_media_response_unknown', 'unknown');
      }
    } catch (error) {
      const failure = error instanceof BotError ? error : new BotError('telegram_media_outcome_unknown', 'unknown');
      const exhausted = failure.outcome === 'retryable' && batch.attempt_count + 1 >= settings.requestMaxAttempts;
      const outcome = exhausted ? 'failed' : failure.outcome;
      const code = exhausted ? 'publication_media_retry_exhausted' : failure.code;
      // Preserve the bot-wide cooldown even when this batch has exhausted its retries.
      const retryAt = failure.outcome === 'retryable' ? new Date(Date.now() + Math.max(failure.retryAfterMs,
        Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.min(batch.attempt_count,10)))) : null;
      await transaction(async client => {
        await client.query(`UPDATE request_attempts SET status=$2,error_code=$3,next_retry_at=$4,finished_at=now() WHERE id=$1`,
          [attemptId,failure.outcome,failure.code,retryAt]);
        await client.query(`UPDATE publication_media_batches SET status=$2,error_code=$3,next_retry_at=$4 WHERE id=$1`,
          [batch.id,outcome,code,outcome === 'retryable' ? retryAt : null]);
        await client.query(`UPDATE publications SET media_status=CASE WHEN media_status='unknown' THEN 'unknown' ELSE $2 END,
          error_code=CASE WHEN media_status='unknown' THEN 'publication_media_requires_review' ELSE $3 END,updated_at=now() WHERE id=$1`,
          [publication.id,outcome === 'retryable' ? 'pending' : outcome,
            outcome === 'unknown' ? 'publication_media_requires_review' : exhausted ? code : `publication_media_${outcome}`]);
      });
      if (outcome === 'retryable') return false;
      batch.status = outcome;
      continue;
    }
    batch.status = 'sent';
    await transaction(async client => {
      for (const [index,item] of items.entries()) await client.query('UPDATE publication_media_items SET message_id=$2,data=NULL WHERE id=$1', [item.id,ids[index]]);
      await client.query(`UPDATE publication_media_batches SET status='sent',error_code=NULL,next_retry_at=NULL WHERE id=$1`, [batch.id]);
      await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),response_metadata=response_metadata||$2::jsonb WHERE id=$1`,
        [attemptId, JSON.stringify({ messageIds: ids })]);
    });
  }
  const status = batches.some(batch => batch.status === 'unknown') ? 'unknown'
    : batches.some(batch => batch.status === 'failed') ? 'failed' : batches.length ? 'complete'
      : publication.media_status === 'failed' || publication.media_status === 'unknown' ? publication.media_status : 'none';
  await db.query(`UPDATE publications SET media_status=$2,error_code=$3,updated_at=now() WHERE id=$1`,
    [publication.id,status,status === 'unknown' ? 'publication_media_requires_review' : status === 'failed' ? 'publication_media_failed' : null]);
  if (publication.story_id && batches.length) await releaseStoryMedia(publication.story_id).catch(() => {
    console.error('Publication media cache release failed.');
  });
  return true;
}

async function failBatch(batch: Batch, code: string): Promise<void> {
  await db.query(`UPDATE publication_media_batches SET status='failed',error_code=$2,next_retry_at=NULL
    WHERE id=$1 AND status IN ('prepared','retryable')`, [batch.id,code]);
  batch.status = 'failed';
}
