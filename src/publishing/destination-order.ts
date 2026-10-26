import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';

/** The digest lease serializes network requests; this row preserves ordering between leases. */
export async function reservedPublication(destinationId: string, client: Pick<PoolClient, 'query'> = db): Promise<string | null> {
  return (await client.query<{ publication_id: string }>(`SELECT publication_id FROM publication_destination_reservations
    WHERE destination_id=$1`, [destinationId])).rows[0]?.publication_id ?? null;
}

/** Only the owner's media-first requests may pass. Ancillary sends, even its own replies, wait. */
export async function destinationBlocked(destinationId: string, ownerId?: string,
  client: Pick<PoolClient, 'query'> = db): Promise<boolean> {
  const owner = await reservedPublication(destinationId, client);
  return owner !== null && owner !== ownerId;
}

export async function reserveDestination(destinationId: string, publicationId: string, client: Pick<PoolClient, 'query'>): Promise<boolean> {
  await client.query(`INSERT INTO publication_destination_reservations(destination_id,publication_id) VALUES($1,$2)
    ON CONFLICT DO NOTHING`, [destinationId, publicationId]);
  return await reservedPublication(destinationId, client) === publicationId;
}

const stopped = `p.status IN ('failed','uncertain')`;

/** Unknown text can only be reconciled, never resent. It must not hold up later news. */
export async function releaseDestination(publicationId: string, client: Pick<PoolClient, 'query'>): Promise<void> {
  await client.query(`UPDATE publication_media_batches b SET status='failed',error_code='publication_stopped',next_retry_at=NULL
    FROM publications p WHERE b.publication_id=p.id AND p.id=$1 AND ${stopped} AND b.status IN ('prepared','retryable')`, [publicationId]);
  await client.query(`UPDATE publications p SET media_status=CASE WHEN EXISTS(
      SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status IN ('running','unknown'))
      THEN 'unknown' ELSE 'failed' END,updated_at=now()
    WHERE p.id=$1 AND ${stopped} AND p.media_status='pending'`, [publicationId]);
  await client.query(`DELETE FROM publication_destination_reservations r USING publications p
    WHERE r.publication_id=p.id AND p.id=$1 AND p.delivery_kind='media_first'
      AND ((p.status='published' AND p.message_id IS NOT NULL) OR ${stopped})
      AND NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status='running')`, [publicationId]);
}

/** Clear receipts and terminal stops left by an older process before checking destination ownership. */
export async function recoverDestination(destinationId: string): Promise<string | null> {
  return transaction(async client => {
    const owner = await reservedPublication(destinationId,client);
    if (owner) await releaseDestination(owner,client);
    return reservedPublication(destinationId,client);
  });
}
