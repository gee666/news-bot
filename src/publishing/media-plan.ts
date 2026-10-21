import { createHash, randomUUID } from 'node:crypto';
import { transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { publicationMedia } from '../media/story-media.js';
import { BotError, mediaUploadType, type PublicationMedia } from './bot-api.js';
import type { Publication } from './store.js';

export function deduplicateMedia(media: PublicationMedia[]): Array<PublicationMedia & { digest: string }> {
  const seen = new Map<string, PublicationMedia & { digest: string }>();
  return media.flatMap(item => {
    if (!Buffer.isBuffer(item.data) || !item.data.length || !['image', 'video'].includes(item.type)
      || !/^(image|video)\/[a-z0-9.+-]+$/iu.test(item.mimeType)
      || item.expiresAt !== undefined && (!Number.isFinite(item.expiresAt) || item.expiresAt <= 0)) {
      throw new BotError('publication_media_invalid', 'failed');
    }
    const digest = createHash('sha256').update(item.data).digest('hex');
    const existing = seen.get(digest);
    if (existing) {
      if (item.expiresAt !== undefined) existing.expiresAt = Math.min(existing.expiresAt ?? Infinity, item.expiresAt);
      return [];
    }
    const unique = { ...item, digest };
    seen.set(digest, unique);
    return [unique];
  });
}

/** Telegram permits photo/video albums together, but documents need their own albums. */
export function partitionMedia<T extends PublicationMedia>(media: T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let documents = false;
  for (const item of media) {
    const document = mediaUploadType(item) === 'document';
    if (batch.length && (batch.length === 10 || document !== documents)) {
      batches.push(batch);
      batch = [];
    }
    documents = document;
    batch.push(item);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

/** Download and commit the entire upload plan before the canonical Telegram request. */
export async function preparePublicationMedia(publication: Publication, settings: AppSettings): Promise<boolean> {
  if (!publication.story_id) return false;
  if (publication.media_snapshot_id === publication.snapshot_id) {
    if (publication.media_status === 'failed' || publication.media_status === 'unknown') {
      throw new BotError('publication_media_plan_unavailable', 'failed');
    }
    return publication.media_status !== 'none';
  }
  const media = deduplicateMedia(await publicationMedia(publication.story_id, settings));
  if (!media.length && !publication.media_snapshot_id) return false;
  await transaction(async client => {
    const current = (await client.query<Publication>('SELECT * FROM publications WHERE id=$1 FOR UPDATE', [publication.id])).rows[0];
    if (!current || current.status !== 'prepared' || current.message_id || current.snapshot_id !== publication.snapshot_id) {
      throw new BotError('publication_media_plan_changed', 'failed');
    }
    const previous = (await client.query<{ digest: string; expires_at: Date }>(`SELECT i.digest,i.expires_at
      FROM publication_media_items i JOIN publication_media_batches b ON b.id=i.batch_id WHERE b.publication_id=$1`, [publication.id])).rows;
    const deadlines = new Map(previous.map(item => [item.digest, item.expires_at.getTime()]));
    await client.query('DELETE FROM publication_media_batches WHERE publication_id=$1', [publication.id]);
    for (const [batchNumber, batch] of partitionMedia(media).entries()) {
      const batchId = randomUUID();
      await client.query('INSERT INTO publication_media_batches(id,publication_id,batch_number) VALUES($1,$2,$3)',
        [batchId, publication.id, batchNumber]);
      for (const [ordinal, item] of batch.entries()) {
        const deadline = Math.min(Date.now() + 7 * 24 * 60 * 60 * 1000, item.expiresAt ?? Infinity, deadlines.get(item.digest) ?? Infinity);
        if (deadline <= Date.now()) throw new BotError('publication_media_expired', 'failed');
        await client.query(`INSERT INTO publication_media_items(batch_id,ordinal,type,mime_type,digest,data,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,to_timestamp($7::double precision/1000))`,
        [batchId, ordinal, item.type, item.mimeType, item.digest, item.data, deadline]);
      }
    }
    await client.query(`UPDATE publications SET media_snapshot_id=$2,media_status=$3,updated_at=now() WHERE id=$1`,
      [publication.id, publication.snapshot_id, media.length ? 'pending' : 'none']);
  });
  return media.length > 0;
}

/** Caller holds the digest lease. A crashed upload may have reached Telegram. */
export async function recoverPublicationMedia(destinationId: string): Promise<void> {
  await transaction(async client => {
    const recovered = await client.query<{ publication_id: string }>(`UPDATE publication_media_batches b
      SET status='unknown',error_code='publication_media_restart_unknown',next_retry_at=NULL
      FROM publications p WHERE p.id=b.publication_id AND p.destination_id=$1 AND b.status='running'
      RETURNING b.publication_id`, [destinationId]);
    if (recovered.rows.length) await client.query(`UPDATE publications SET media_status='unknown',
      error_code='publication_media_requires_review',updated_at=now() WHERE id=ANY($1::uuid[])`,
    [recovered.rows.map(row => row.publication_id)]);
  });
}

/** Bytea is a temporary upload spool, never an archive, including for unresolved sends. */
export async function expirePublicationMedia(): Promise<void> {
  await transaction(async client => {
    const expired = await client.query<{ batch_id: string }>(`UPDATE publication_media_items SET data=NULL
      WHERE data IS NOT NULL AND expires_at<=now() RETURNING batch_id`);
    if (!expired.rows.length) return;
    const ids = expired.rows.map(row => row.batch_id);
    await client.query(`UPDATE publication_media_batches SET status='failed',error_code='publication_media_expired',next_retry_at=NULL
      WHERE id=ANY($1::uuid[]) AND status IN ('prepared','retryable')`, [ids]);
    await client.query(`UPDATE publications p SET media_status=CASE WHEN EXISTS(
        SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status IN ('running','unknown'))
        THEN 'unknown' ELSE 'failed' END,error_code='publication_media_expired',updated_at=now()
      WHERE EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.id=ANY($1::uuid[]) AND b.status<>'sent')`, [ids]);
  });
}
