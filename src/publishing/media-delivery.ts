import { db, transaction } from '../db.js';
import { getSettings, type AppSettings } from '../settings.js';
import { releaseStoryMedia } from '../media/story-media.js';
import { BotApi, BotError, type PublicationMedia } from './bot-api.js';
import { expirePublicationMedia } from './media-plan.js';
import { destinationBlocked } from './destination-order.js';
import { destination, publicationSelect, rateLimited, type Publication } from './store.js';

interface Batch { id: string; status: string; attempt_count: number; next_retry_at: Date | null }
interface Item { id: string; type: PublicationMedia['type']; mime_type: string; data: Buffer | null; message_id: string | null; expires_at: Date }

async function finishMedia(publication: Publication): Promise<boolean> {
  const result = await db.query<{ complete: boolean }>(`UPDATE publications p SET media_status='complete',
    error_code=CASE WHEN error_code LIKE 'publication_media_%' THEN NULL ELSE error_code END,updated_at=now()
    WHERE p.id=$1 AND NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status<>'sent')
    RETURNING true AS complete`, [publication.id]);
  if (!result.rows[0]?.complete) return false;
  if (publication.story_id) await releaseStoryMedia(publication.story_id).catch(() => {
    // Cache expiry also runs independently. Delivery has already committed.
    console.error('Publication media cache release failed.');
  });
  return true;
}

/** Only explicit Telegram rejections may be retried. Unknown batches require manual review. */
export async function deliverPublicationMedia(publication: Publication, api: BotApi, settings: AppSettings): Promise<boolean> {
  if (await destinationBlocked(publication.destination_id)) return false;
  if (publication.delivery_kind === 'media_first' || publication.delivery_kind === 'album' || !publication.message_id || publication.status !== 'published') return false;
  if ((await db.query(`SELECT 1 FROM publication_text_parts WHERE publication_id=$1 AND status<>'sent' LIMIT 1`, [publication.id])).rows.length) return false;
  const botId = String((await api.identity()).id);
  if (publication.bot_id !== botId) return false;
  const batches = (await db.query<Batch>(`SELECT * FROM publication_media_batches WHERE publication_id=$1 ORDER BY batch_number`,
    [publication.id])).rows;
  for (const batch of batches) {
    if (batch.status === 'sent') continue;
    if (!['prepared', 'retryable'].includes(batch.status) || batch.next_retry_at && batch.next_retry_at > new Date()) return false;
    const current = await getSettings();
    if (!current.publishingEnabled || JSON.stringify(current) !== JSON.stringify(settings)
      || await destination() !== publication.destination_id || await rateLimited()) return false;
    const items = (await db.query<Item>('SELECT * FROM publication_media_items WHERE batch_id=$1 ORDER BY ordinal', [batch.id])).rows;
    if (!items.length || items.some(item => !item.data)) return false;
    if (items.some(item => item.expires_at.getTime() <= Date.now())) {
      await expirePublicationMedia();
      return false;
    }
    const claimed = await transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
      const owner = (await client.query<Publication>(`SELECT * FROM publications p WHERE p.id=$1 AND p.status='published'
        AND p.message_id=$2 AND p.destination_id=$3 AND p.bot_id=$4
        AND NOT EXISTS(SELECT 1 FROM operational_state WHERE key='publication_removal:'||p.id::text)
        AND NOT EXISTS(SELECT 1 FROM publication_replacements WHERE duplicate_publication_id=p.id AND status<>'failed')
        FOR UPDATE`, [publication.id, publication.message_id, publication.destination_id, botId])).rows[0];
      if (!owner || await destinationBlocked(publication.destination_id,undefined,client) || await rateLimited(client)) return false;
      return (await client.query(`UPDATE publication_media_batches SET status='running',attempt_count=attempt_count+1,
        dispatched_at=now(),error_code=NULL,next_retry_at=NULL WHERE id=$1 AND status IN ('prepared','retryable')
        AND (next_retry_at IS NULL OR next_retry_at<=now())
        AND NOT EXISTS(SELECT 1 FROM publication_media_items WHERE batch_id=$1 AND expires_at<=now())
        RETURNING id`, [batch.id])).rows.length > 0;
    });
    if (!claimed) return false;
    let ids: string[];
    try {
      const media = items.map(item => {
        if (!item.data) throw new BotError('publication_media_expired', 'failed');
        return { type: item.type, data: item.data, mimeType: item.mime_type };
      });
      ids = await api.sendMedia(publication.destination_id, publication.message_id, media);
      if (ids.length !== items.length || new Set(ids).size !== items.length || ids.some(id => !/^[1-9]\d*$/u.test(id))) {
        throw new BotError('telegram_media_response_unknown', 'unknown');
      }
    } catch (error) {
      const failure = error instanceof BotError ? error : new BotError('telegram_media_outcome_unknown', 'unknown');
      const retryAt = failure.outcome !== 'retryable' ? null : new Date(Date.now() + Math.max(failure.retryAfterMs,
        Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.min(batch.attempt_count, 10))));
      await transaction(async client => {
        await client.query(`UPDATE publication_media_batches SET status=$2,error_code=$3,next_retry_at=$4 WHERE id=$1`,
          [batch.id, failure.outcome, failure.code, retryAt]);
        await client.query(`UPDATE publications SET media_status=$2,error_code=$3,updated_at=now() WHERE id=$1`,
          [publication.id, failure.outcome === 'retryable' ? 'pending' : failure.outcome,
            failure.outcome === 'unknown' ? 'publication_media_requires_review' : `publication_media_${failure.outcome}`]);
      });
      return false;
    }
    await transaction(async client => {
      for (const [index, item] of items.entries()) await client.query(`UPDATE publication_media_items SET message_id=$2,data=NULL WHERE id=$1`,
        [item.id, ids[index]]);
      await client.query(`UPDATE publication_media_batches SET status='sent',error_code=NULL,next_retry_at=NULL WHERE id=$1`, [batch.id]);
    });
  }
  return finishMedia(publication);
}

export async function retryPublicationMedia(api: BotApi, settings: AppSettings, destinationId: string): Promise<void> {
  const pending = (await db.query<Publication>(`${publicationSelect} WHERE p.destination_id=$1 AND p.delivery_kind='text' AND p.status='published'
    AND p.media_status='pending' AND (NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status<>'sent')
      OR EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id
        AND b.status IN ('prepared','retryable') AND (b.next_retry_at IS NULL OR b.next_retry_at<=now()))) ORDER BY p.created_at`,
  [destinationId])).rows;
  for (const publication of pending) {
    if (await rateLimited()) break;
    await deliverPublicationMedia(publication, api, settings);
  }
}

/** Called only inside an already authorized canonical deletion. Unknown uploads are not guessed. */
export async function deletePublicationMedia(publication: Publication, api: BotApi): Promise<void> {
  const unresolved = await db.query(`SELECT 1 FROM publication_media_batches WHERE publication_id=$1 AND status IN ('running','unknown')`, [publication.id]);
  if (unresolved.rows.length) throw new BotError('publication_media_requires_review', 'failed');
  const items = (await db.query<Item>(`SELECT i.* FROM publication_media_items i JOIN publication_media_batches b ON b.id=i.batch_id
    WHERE b.publication_id=$1 AND i.message_id IS NOT NULL AND i.deleted_at IS NULL ORDER BY b.batch_number,i.ordinal`, [publication.id])).rows;
  for (const item of items) {
    // The caller deletes the canonical caption message exactly once, after its siblings.
    if (!item.message_id || item.message_id === publication.message_id) continue;
    await api.delete(publication.destination_id, item.message_id);
    await db.query('UPDATE publication_media_items SET deleted_at=now(),data=NULL WHERE id=$1', [item.id]);
  }
  await db.query(`UPDATE publication_media_items SET data=NULL WHERE batch_id IN
    (SELECT id FROM publication_media_batches WHERE publication_id=$1)`, [publication.id]);
}

/** Delete siblings before the caption, retaining per-item progress for authorized retries. */
export async function deletePublicationMessages(publication: Publication, api: BotApi): Promise<void> {
  if (await destinationBlocked(publication.destination_id)) throw new BotError('destination_reserved', 'failed');
  if (!publication.message_id) throw new BotError('publication_message_missing', 'failed');
  const unknownText = await db.query(`SELECT 1 FROM publication_text_parts WHERE publication_id=$1 AND status IN ('running','unknown') LIMIT 1`, [publication.id]);
  if (unknownText.rows.length) throw new BotError('publication_text_requires_review','failed');
  const unknownNavigation = await db.query(`SELECT 1 FROM publication_navigation_parts
    WHERE publication_id=$1 AND status IN ('running','unknown') LIMIT 1`,[publication.id]);
  if (unknownNavigation.rows.length) throw new BotError('publication_navigation_requires_review','failed');
  const navigation = await db.query<{ slot:string; message_id:string }>(`SELECT slot,message_id FROM publication_navigation_parts
    WHERE publication_id=$1 AND text_part_number IS NULL AND message_id IS NOT NULL AND deleted_at IS NULL ORDER BY slot`,[publication.id]);
  for (const part of navigation.rows) {
    await api.delete(publication.destination_id,part.message_id);
    await db.query('UPDATE publication_navigation_parts SET deleted_at=now() WHERE publication_id=$1 AND slot=$2',[publication.id,part.slot]);
  }
  const parts = (await db.query<{ part_number: number; message_id: string }>(`SELECT part_number,message_id FROM publication_text_parts
    WHERE publication_id=$1 AND part_number>0 AND message_id IS NOT NULL AND deleted_at IS NULL ORDER BY part_number`, [publication.id])).rows;
  for (const part of parts) {
    await api.delete(publication.destination_id,part.message_id);
    await db.query('UPDATE publication_text_parts SET deleted_at=now() WHERE publication_id=$1 AND part_number=$2', [publication.id,part.part_number]);
  }
  await deletePublicationMedia(publication, api);
  const deleted = (await db.query(`SELECT 1 FROM publication_media_items i JOIN publication_media_batches b ON b.id=i.batch_id
    WHERE b.publication_id=$1 AND i.message_id=$2 AND i.deleted_at IS NOT NULL
      UNION ALL SELECT 1 FROM publication_text_parts WHERE publication_id=$1 AND part_number=0 AND message_id=$2 AND deleted_at IS NOT NULL`, [publication.id, publication.message_id])).rows.length > 0;
  if (deleted) return;
  await api.delete(publication.destination_id, publication.message_id);
  await db.query('UPDATE publication_text_parts SET deleted_at=now() WHERE publication_id=$1 AND part_number=0', [publication.id]);
  await db.query(`UPDATE publication_media_items i SET deleted_at=now(),data=NULL FROM publication_media_batches b
    WHERE b.id=i.batch_id AND b.publication_id=$1 AND i.message_id=$2`, [publication.id, publication.message_id]);
}
