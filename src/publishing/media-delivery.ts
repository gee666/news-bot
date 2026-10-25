import { db } from '../db.js';
import { BotApi, BotError } from './bot-api.js';
import { destinationBlocked } from './destination-order.js';
import type { Publication } from './store.js';

interface Item { id: string; message_id: string | null }

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
  await deletePublicationMedia(publication, api);
  const deleted = (await db.query(`SELECT 1 FROM publication_media_items i JOIN publication_media_batches b ON b.id=i.batch_id
    WHERE b.publication_id=$1 AND i.message_id=$2 AND i.deleted_at IS NOT NULL`, [publication.id, publication.message_id])).rows.length > 0;
  if (deleted) return;
  await api.delete(publication.destination_id, publication.message_id);
  await db.query(`UPDATE publication_media_items i SET deleted_at=now(),data=NULL FROM publication_media_batches b
    WHERE b.id=i.batch_id AND b.publication_id=$1 AND i.message_id=$2`, [publication.id, publication.message_id]);
}
