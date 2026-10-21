import { z } from 'zod';
import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';
import { releaseStoryMedia } from '../media/story-media.js';
import { BotError, MAX_ALBUM_MEDIA, type PublicationMedia } from './bot-api.js';
import type { Publication } from './store.js';

interface AlbumItem {
  id: string; type: PublicationMedia['type']; mime_type: string; digest: string; data: Buffer | null; expires_at: Date;
}
export interface AlbumPlan { items: AlbumItem[]; media: PublicationMedia[] }
const albumMetadataSchema = z.object({ deliveryKind: z.literal('album'), itemIds: z.array(z.uuid()).min(1).max(MAX_ALBUM_MEDIA) });

export async function readAlbumPlan(publication: Publication): Promise<AlbumPlan> {
  const items = (await db.query<AlbumItem>(`SELECT i.* FROM publication_media_items i
    JOIN publication_media_batches b ON b.id=i.batch_id WHERE b.publication_id=$1 ORDER BY b.batch_number,i.ordinal`, [publication.id])).rows;
  if (!items.length || items.length > MAX_ALBUM_MEDIA) throw new BotError('publication_album_plan_invalid', 'failed');
  const media = items.map(item => {
    if (!item.data?.length || item.expires_at.getTime() <= Date.now()) throw new BotError('publication_media_expired', 'failed');
    return { type: item.type, mimeType: item.mime_type, data: item.data };
  });
  return { items, media };
}

/** Called inside beginAttempt's admission transaction, under the publication row lock. */
export async function claimAlbum(client: Pick<PoolClient, 'query'>, publication: Publication, metadata: object): Promise<boolean> {
  const parsed = albumMetadataSchema.safeParse(metadata);
  if (!parsed.success) return false;
  const batches = (await client.query<{ id: string; status: string }>(`SELECT id,status FROM publication_media_batches
    WHERE publication_id=$1 ORDER BY batch_number FOR UPDATE`, [publication.id])).rows;
  const batch = batches[0];
  if (batches.length !== 1 || !batch || !['prepared', 'retryable'].includes(batch.status)) return false;
  const items = (await client.query<{ id: string; available: boolean }>(`SELECT id,(data IS NOT NULL AND octet_length(data)>0 AND expires_at>now()) AS available
    FROM publication_media_items WHERE batch_id=$1 ORDER BY ordinal FOR UPDATE`, [batch.id])).rows;
  if (items.length !== parsed.data.itemIds.length || items.some((item, index) => !item.available || item.id !== parsed.data.itemIds[index])) return false;
  await client.query(`UPDATE publication_media_batches SET status='running',attempt_count=attempt_count+1,
    dispatched_at=now(),error_code=NULL,next_retry_at=NULL WHERE id=$1`, [batch.id]);
  return true;
}

export async function recordAlbumFailure(client: Pick<PoolClient, 'query'>, publication: Publication,
  failure: BotError, retryAt: Date | null): Promise<void> {
  if (publication.delivery_kind !== 'album') return;
  await client.query(`UPDATE publication_media_batches SET status=$2,error_code=$3,next_retry_at=$4
    WHERE publication_id=$1 AND status='running'`, [publication.id, failure.outcome, failure.code, retryAt]);
  await client.query(`UPDATE publications SET media_status=$2 WHERE id=$1`,
    [publication.id, failure.outcome === 'retryable' ? 'pending' : failure.outcome]);
}

export async function completeAlbum(publication: Publication, attemptId: string | null, messageIds: string[], metadata: object): Promise<void> {
  if (!messageIds.length || messageIds.length > MAX_ALBUM_MEDIA || new Set(messageIds).size !== messageIds.length
    || messageIds.some(id => !/^[1-9]\d*$/u.test(id))) throw new BotError('telegram_album_response_unknown', 'unknown');
  await transaction(async client => {
    const items = (await client.query<{ id: string }>(`SELECT i.id FROM publication_media_items i JOIN publication_media_batches b ON b.id=i.batch_id
      WHERE b.publication_id=$1 ORDER BY b.batch_number,i.ordinal FOR UPDATE OF i`, [publication.id])).rows;
    if (items.length !== messageIds.length) throw new BotError('telegram_album_response_unknown', 'unknown');
    for (const [index, item] of items.entries()) await client.query(`UPDATE publication_media_items SET message_id=$2,data=NULL WHERE id=$1`,
      [item.id, messageIds[index]]);
    await client.query(`UPDATE publication_media_batches SET status='sent',error_code=NULL,next_retry_at=NULL WHERE publication_id=$1`, [publication.id]);
    await client.query(`UPDATE publications SET status='published',message_id=$2,published_at=coalesce(published_at,now()),
      media_status='complete',next_retry_at=NULL,error_code=NULL,format_version=1,updated_at=now() WHERE id=$1`, [publication.id, messageIds[0]]);
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata||$2::jsonb WHERE publication_id=$1 AND operation='send'
      AND ($3::uuid IS NULL OR id=$3) AND status IN ('running','unknown')`,
    [publication.id, JSON.stringify({ ...metadata, messageId: messageIds[0], messageIds }), attemptId]);
  });
  if (publication.story_id) await releaseStoryMedia(publication.story_id).catch(() => {
    console.error('Publication media cache release failed.');
  });
}
