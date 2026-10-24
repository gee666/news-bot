import type { PoolClient } from 'pg';
import { transaction } from '../db.js';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import { snapshotHash } from './approval.js';
import { supersedeAttempts } from './store.js';

/** A complete frozen post, including every text part and media attachment. */
const delivered = `p.status='published' AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL
  AND p.media_status IN ('none','complete')
  AND NOT EXISTS(SELECT 1 FROM publication_text_parts t WHERE t.publication_id=p.id AND t.status<>'sent')
  AND NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status<>'sent')
  AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||p.id::text)
  AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id)`;

/** Frozen links, not live story metadata, establish ancestry after retention. */
export async function latestUpdateTarget(client: Pick<PoolClient,'query'>, publicationId: string): Promise<string | null> {
  const row = (await client.query<{ url: string }>(`SELECT 'https://t.me/c/'||substring(p.destination_id from 5)||'/'||p.message_id AS url
    FROM publications old JOIN publications p ON p.destination_id=old.destination_id AND p.bot_id=old.bot_id AND p.id<>old.id
    JOIN publication_snapshots snap ON snap.id=p.snapshot_id
    WHERE old.id=$1 AND old.status='published' AND old.message_id IS NOT NULL AND ${delivered}
      AND p.destination_id ~ '^-100[0-9]+$' AND p.message_id ~ '^[1-9][0-9]*$'
      AND (p.published_at,p.id)>(coalesce(old.published_at,old.created_at),old.id)
      AND snap.content->'sources' @> jsonb_build_array(jsonb_build_object('previousPublication',true,
        'url','https://t.me/c/'||substring(old.destination_id from 5)||'/'||old.message_id))
    ORDER BY p.published_at DESC,p.id DESC LIMIT 1`, [publicationId])).rows[0];
  return row?.url ?? null;
}

export function markerOnlyChange(sent: PublicationSnapshot, desired: PublicationSnapshot): boolean {
  return Boolean(desired.updatedTo) && snapshotHash({ ...sent, updatedTo: undefined }) === snapshotHash({ ...desired, updatedTo: undefined });
}

/** One candidate query per tick. Unchanged history takes no row locks or per-publication reads. */
export async function prepareThreadUpdates(destinationId: string, latestPublicationIds?: string[]): Promise<void> {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const rows = await client.query<{ id: string; story_id: string | null; content: unknown; target: string }>(`
      WITH complete AS MATERIALIZED (
        SELECT p.id,p.bot_id,p.destination_id,p.message_id,p.published_at,snap.content FROM publications p
        JOIN publication_snapshots snap ON snap.id=p.snapshot_id
        WHERE p.destination_id=$1 AND ($2::uuid[] IS NULL OR p.id=ANY($2)) AND p.destination_id ~ '^-100[0-9]+$' AND p.message_id ~ '^[1-9][0-9]*$' AND ${delivered}
      ), targets AS (
        SELECT DISTINCT ON (old.id) old.id,'https://t.me/c/'||substring(latest.destination_id from 5)||'/'||latest.message_id AS url
        FROM complete latest CROSS JOIN LATERAL jsonb_array_elements(latest.content->'sources') source
        JOIN publications old ON old.destination_id=latest.destination_id AND old.bot_id=latest.bot_id
          AND source->>'url'='https://t.me/c/'||substring(old.destination_id from 5)||'/'||old.message_id
        WHERE source->>'previousPublication'='true' AND old.status='published' AND old.message_id IS NOT NULL
          AND (latest.published_at,latest.id)>(coalesce(old.published_at,old.created_at),old.id)
        ORDER BY old.id,latest.published_at DESC,latest.id DESC
      )
      SELECT p.id,p.story_id,sent.content,targets.url AS target FROM targets JOIN publications p ON p.id=targets.id
      JOIN publication_snapshots sent ON sent.id=p.snapshot_id
      LEFT JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id
      WHERE ${delivered}
        AND NOT (coalesce(desired.content,sent.content)->>'updatedTo' IS NOT DISTINCT FROM targets.url
          AND (coalesce(desired.content,sent.content)-'updatedTo')=(sent.content-'updatedTo'))
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit' AND a.status IN ('running','unknown'))
      ORDER BY p.id FOR UPDATE OF p`, [destinationId,latestPublicationIds ?? null]);
    for (const row of rows.rows) {
      const sent = publicationSnapshotSchema.parse(row.content);
      const snapshot = (await client.query<{ id: string }>(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
        [row.story_id,JSON.stringify({ ...sent,updatedTo:row.target })])).rows[0];
      if (!snapshot) throw new Error('Thread marker snapshot insert failed');
      await supersedeAttempts(client,[row.id],'edit');
      await client.query('UPDATE publications SET pending_snapshot_id=$2,updated_at=now() WHERE id=$1', [row.id,snapshot.id]);
    }
  });
}
