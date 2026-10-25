import type { PoolClient } from 'pg';
import type { PublicationSnapshot } from '../types.js';
import { renderStoredPublication } from './message-render.js';
import type { Publication } from './store.js';

/** Canonical rendering must fit before staging. Never schedule link-only overflow messages. */
export async function prepareNavigationParts(client: Pick<PoolClient,'query'>, publicationId: string,
  snapshotId: string, snapshot: PublicationSnapshot): Promise<void> {
  const owner = (await client.query<{ delivery_kind:Publication['delivery_kind'] }>(
    'SELECT delivery_kind FROM publications WHERE id=$1',[publicationId])).rows[0];
  await renderStoredPublication(client,publicationId,snapshot,owner?.delivery_kind);
  // Retire only proven-unsent work. Sent and ambiguous historical replies remain untouched.
  await client.query(`DELETE FROM publication_navigation_parts WHERE publication_id=$1
    AND snapshot_id<>$2 AND message_id IS NULL AND status IN ('prepared','retryable')`,[publicationId,snapshotId]);
}
