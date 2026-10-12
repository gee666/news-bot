import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { parsePrimarySource } from './repository.js';
import { publicUrl } from '../pipeline/research-fetch.js';
import { publisherArticle } from './config.js';

const snapshotSchema = z.object({ source: z.record(z.string(), z.unknown()), item: z.object({
  id: z.uuid(), source_id: z.uuid(), external_id: z.string(), original_url: z.string(),
  published_at: z.iso.datetime({ offset: true }).nullable(), retention_at: z.iso.datetime({ offset: true }),
  current_revision_id: z.uuid(), metadata: z.record(z.string(), z.unknown()),
}), revision_hash: z.string(), revision_metadata: z.object({ connectorKind: z.enum(['feed', 'website']) }) });
export async function publisherRefreshState(client: Pick<PoolClient, 'query'>, itemId: string, batchId: string, lock = false) {
  z.uuid().parse(itemId); z.uuid().parse(batchId);
  const batch = await client.query(`SELECT status FROM processing_batches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [batchId]);
  if (!z.object({ status: z.enum(['failed', 'waiting']) }).safeParse(batch.rows[0]).success) {
    throw new Error('publisher_refresh_batch_not_parked');
  }
  const running = await client.query("SELECT 1 FROM stage_state WHERE batch_id=$1 AND status='running' LIMIT 1", [batchId]);
  if (running.rows.length) throw new Error('publisher_refresh_work_running');
  const result = await client.query(`SELECT to_jsonb(s) AS source,to_jsonb(i) AS item,r.metadata AS revision_metadata,r.content_hash AS revision_hash
    FROM source_items i JOIN sources s ON s.id=i.source_id JOIN item_revisions r ON r.id=i.current_revision_id
    JOIN batch_sources bs ON bs.source_id=s.id AND bs.batch_id=$2
    WHERE i.id=$1 AND EXISTS(SELECT 1 FROM batch_items bi JOIN item_revisions old ON old.id=bi.revision_id
      WHERE bi.batch_id=$2 AND old.item_id=i.id)${lock ? ' FOR UPDATE OF s,i,bs' : ''}`, [itemId, batchId]);
  const parsed = snapshotSchema.safeParse(result.rows[0]);
  if (!parsed.success) throw new Error('publisher_refresh_invalid_item');
  const snapshot = parsed.data;
  if (snapshot.source.access !== 'public') throw new Error('publisher_refresh_nonpublic_source');
  const source = (() => {
    try { return parsePrimarySource(snapshot.source); }
    catch { throw new Error('publisher_refresh_invalid_source'); }
  })();
  if (source.id !== snapshot.item.source_id || source.kind !== snapshot.revision_metadata.connectorKind) {
    throw new Error('publisher_refresh_identity_drift');
  }
  const url = publicUrl(snapshot.item.original_url).href;
  if (publisherArticle(url, source) !== url) throw new Error('publisher_refresh_invalid_url');
  const fingerprint = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return { source, item: snapshot.item, url, fingerprint, revisionHash: snapshot.revision_hash };
}
