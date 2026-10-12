import type { PoolClient } from "pg";
import { z } from "zod";
import { transaction } from "../db.js";
import { revisionHash } from "./content.js";
import type { SourceCollectedItem } from "./types.js";
import { publisherRefreshState } from "./refresh-state.js";
import { PrimaryCollectionError } from "./collector-errors.js";

const itemRow = z.object({ id: z.uuid(), current_revision_id: z.uuid().nullable() });
const idRow = z.object({ id: z.uuid() });

async function saveItem(client: PoolClient, sourceId: string, item: SourceCollectedItem, preservePublication = false): Promise<string | null> {
  const metadata = { ...item.metadata, editedAt: item.editedAt?.toISOString() ?? null };
  const result = await client.query(
    `INSERT INTO source_items(source_id,external_id,original_url,published_at,retention_at,metadata)
     VALUES($1,$2,$3,$4,COALESCE($4,now()),$5::jsonb)
     ON CONFLICT(source_id,external_id) DO UPDATE
     SET original_url=EXCLUDED.original_url, metadata=EXCLUDED.metadata,
         published_at=CASE WHEN $6 THEN source_items.published_at ELSE COALESCE(EXCLUDED.published_at,source_items.published_at) END
     RETURNING id,current_revision_id`,
    [sourceId, item.externalId, item.originalUrl, item.publishedAt, JSON.stringify(metadata), preservePublication],
  );
  const saved = itemRow.parse(result.rows[0]);
  const hash = revisionHash(item);
  const existing = await client.query("SELECT id FROM item_revisions WHERE item_id=$1 AND content_hash=$2", [saved.id, hash]);
  let revisionId: string;
  if (existing.rows.length) {
    revisionId = idRow.parse(existing.rows[0]).id;
  } else {
    const revision = await client.query(
      `INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
       SELECT $1,COALESCE(MAX(revision_number),0)+1,$2,$3,$4,$5::jsonb
       FROM item_revisions WHERE item_id=$1 RETURNING id`,
      [saved.id, hash, item.originalText, item.normalizedText, JSON.stringify(metadata)],
    );
    revisionId = idRow.parse(revision.rows[0]).id;
    for (const link of item.links) {
      await client.query(
        `INSERT INTO item_links(revision_id,url,anchor_text,start_offset,end_offset,metadata)
         VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
        [revisionId, link.url, link.anchorText, link.startOffset, link.endOffset, JSON.stringify(link.metadata)],
      );
    }
  }
  if (saved.current_revision_id === revisionId) return null;
  await client.query("UPDATE source_items SET current_revision_id=$2 WHERE id=$1", [saved.id, revisionId]);
  return revisionId;
}

export class PostgresSourceCollectionStore {
  /** Operator repair only. Caller holds news-bot-pipeline lease; normal collection stays budgeted. */
  async commitPublisherRefresh(batchId: string, itemId: string, fingerprint: string, item: SourceCollectedItem):
    Promise<{ itemId: string; revisionId: string; changed: boolean }> {
    return transaction(async client => {
      const state = await publisherRefreshState(client, itemId, batchId, true);
      if (state.fingerprint !== fingerprint || item.externalId !== state.item.external_id || item.originalUrl !== state.item.original_url
        || item.publishedAt?.toISOString() !== (state.item.published_at === null ? undefined : new Date(state.item.published_at).toISOString())) {
        throw new Error('publisher_refresh_identity_drift');
      }
      if (revisionHash(item) === state.revisionHash) return { itemId, revisionId: state.item.current_revision_id, changed: false };
      const revisionId = await saveItem(client, state.source.id, item, true);
      if (!revisionId) throw new Error('publisher_refresh_revision_conflict');
      await client.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [batchId, revisionId]);
      return { itemId, revisionId, changed: true };
    });
  }

  async commitSource(
    batchId: string, source: { id: string; configVersion?: number }, items: readonly SourceCollectedItem[], cursor: object,
  ): Promise<number> {
    return this.commitProgress(batchId, source, items, cursor, true);
  }

  async commitProgress(batchId: string, source: { id: string; configVersion?: number }, items: readonly SourceCollectedItem[],
    cursor: object, completed: boolean): Promise<number> {
    return await transaction(async client => {
      // Publisher edits and checkpoints lock source before batch. Telegram keeps its existing path.
      if (source.configVersion !== undefined || Object.hasOwn(cursor, 'backlog')) {
        const savedSource = await client.query('SELECT collection_config_version FROM sources WHERE id=$1 FOR UPDATE', [source.id]);
        const version = z.object({ collection_config_version: z.number().int().min(1) }).parse(savedSource.rows[0]).collection_config_version;
        if (source.configVersion !== undefined && source.configVersion !== version) {
          throw new PrimaryCollectionError('primary_source_config_changed', { phase: 'store', reason: 'config_changed' });
        }
      }
      const batchSource = await client.query(
        "SELECT status FROM batch_sources WHERE batch_id=$1 AND source_id=$2 FOR UPDATE",
        [batchId, source.id],
      );
      const state = z.object({ status: z.enum(["pending", "completed", "failed"]) }).parse(batchSource.rows[0]);
      if (state.status === "completed") return 0;
      let count = 0;
      for (const item of items) {
        const revisionId = await saveItem(client, source.id, item);
        if (!revisionId) continue;
        await client.query(
          "INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [batchId, revisionId],
        );
        count++;
      }
      // Keep publisher identity locked even after retention cleanup removes all its items.
      if (items.length) await client.query(
        `UPDATE sources SET metadata=metadata || '{"publisherIdentityLocked":true}'::jsonb
         WHERE id=$1 AND connector_type IN ('feed','website')`, [source.id],
      );
      const serialized = JSON.stringify(cursor);
      if (completed || Object.hasOwn(cursor, 'backlog')) await client.query(
        `UPDATE sources SET collection_cursor=$2::jsonb,updated_at=now() WHERE id=$1
         AND ($3 OR connector_type IN ('feed','website'))
         AND (NOT ($2::jsonb ? 'backlog') OR collection_cursor->>'cutoff' IS NULL
           OR (collection_cursor->>'cutoff')::timestamptz <= ($2::jsonb->>'cutoff')::timestamptz)`, [source.id, serialized, completed],
      );
      await client.query(
        `UPDATE batch_sources SET cursor_after=$3::jsonb,status=$4,error_code=NULL
         WHERE batch_id=$1 AND source_id=$2`,
        [batchId, source.id, serialized, completed ? "completed" : "pending"],
      );
      return count;
    });
  }
}
