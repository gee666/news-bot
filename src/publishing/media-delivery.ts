import { db } from '../db.js';
import { type AppSettings } from '../settings.js';
import { releaseStoryMedia } from '../media/story-media.js';
import { BotApi, BotError } from './bot-api.js';
import { destinationBlocked } from './destination-order.js';
import { publicationSelect, rateLimited, type Publication } from './store.js';

interface Batch { status: string }
interface Item { id: string; message_id: string | null }

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
  if (!settings.publishingEnabled || await destinationBlocked(publication.destination_id)) return false;
  if (publication.delivery_kind === 'media_first' || publication.delivery_kind === 'album' || !publication.message_id || publication.status !== 'published') return false;
  if ((await db.query(`SELECT 1 FROM publication_text_parts WHERE publication_id=$1 AND status<>'sent' LIMIT 1`, [publication.id])).rows.length) return false;
  const botId = String((await api.identity()).id);
  if (publication.bot_id !== botId) return false;
  const batches = (await db.query<Batch>(`SELECT * FROM publication_media_batches WHERE publication_id=$1 ORDER BY batch_number`,
    [publication.id])).rows;
  for (const batch of batches) {
    if (batch.status === 'sent') continue;
    // Frozen text-first attachments would be replies. Leave them for explicit operator review.
    await db.query(`UPDATE publications SET error_code='publication_replies_forbidden',updated_at=now() WHERE id=$1`, [publication.id]);
    return false;

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
