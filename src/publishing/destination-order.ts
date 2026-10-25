import type { PoolClient } from 'pg';
import { db } from '../db.js';

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

/** Called in the same transaction as the canonical text receipt. Media ids are never canonical. */
export async function releaseDestination(publicationId: string, client: Pick<PoolClient, 'query'>): Promise<void> {
  await client.query(`DELETE FROM publication_destination_reservations r USING publications p
    WHERE r.publication_id=p.id AND p.id=$1 AND p.delivery_kind='media_first' AND p.status='published'
      AND p.message_id IS NOT NULL AND p.media_status IN ('none','complete')`, [publicationId]);
}
