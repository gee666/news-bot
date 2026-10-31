import type { PoolClient } from 'pg';
import type { AppSettings } from '../settings.js';
import { publicationAdmission } from './freshness.js';
import { confirmedDelivery, delivered, sameStoryIds } from './navigation.js';
import { publicationEditSelect, supersedeAttempts, type Publication } from './store.js';

/** Caller holds the history lock. Only a confirmed newer post can replace a delivered post. */
export async function prepareReplacements(client: PoolClient, destinationId: string, latestPublicationIds?: string[]): Promise<void> {
  const older = await client.query<{ id: string; story_id: string }>(`SELECT p.id,
      coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) AS story_id
    FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
    LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    WHERE p.destination_id=$1 AND ${confirmedDelivery} AND p.bot_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id AND r.status<>'pending')
      AND coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id
        AND a.status IN ('running','unknown')) ORDER BY p.id FOR UPDATE OF p`, [destinationId]);
  for (const old of older.rows) {
    const same = await sameStoryIds(client,old.story_id);
    const canonical = (await client.query<{ id: string; snapshot_id: string }>(`SELECT p.id,p.snapshot_id
      FROM publications old JOIN publications p ON p.destination_id=old.destination_id AND p.bot_id=old.bot_id
      LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
      LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
      WHERE old.id=$1 AND p.id<>old.id AND ${delivered} AND p.format_version=1 AND p.pending_snapshot_id IS NULL
        AND coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=ANY($2::uuid[])
        AND ($3::uuid[] IS NULL OR p.id=ANY($3))
        AND (p.published_at,p.id)>(old.published_at,old.id)
      ORDER BY p.published_at DESC,p.id DESC LIMIT 1 FOR UPDATE OF p`,
    [old.id,same,latestPublicationIds ?? null])).rows[0];
    if (!canonical) continue;
    await supersedeAttempts(client,[old.id],'edit');
    await client.query('UPDATE publications SET pending_snapshot_id=NULL,updated_at=now() WHERE id=$1',[old.id]);
    await client.query(`INSERT INTO publication_replacements(duplicate_publication_id,canonical_publication_id,canonical_snapshot_id)
      VALUES($1,$2,$3) ON CONFLICT(duplicate_publication_id) DO UPDATE
      SET canonical_publication_id=EXCLUDED.canonical_publication_id,canonical_snapshot_id=EXCLUDED.canonical_snapshot_id
      WHERE publication_replacements.status='pending' AND NOT EXISTS(SELECT 1 FROM request_attempts a
        WHERE a.publication_id=$1 AND a.operation='delete' AND a.status IN ('running','unknown','succeeded'))`,[old.id,canonical.id,canonical.snapshot_id]);
  }
}

/** Recheck the durable proof immediately before recording a delete attempt. */
export async function replacementAdmitted(client: PoolClient, publication: Publication, settings: AppSettings,
  proof: { canonicalPublicationId: string; canonicalSnapshotId: string }): Promise<boolean> {
  const canonical = (await client.query<Publication>(`${publicationEditSelect} WHERE p.id=$1`,[proof.canonicalPublicationId])).rows[0];
  if (!canonical?.message_id || canonical.snapshot_id!==proof.canonicalSnapshotId || canonical.pending_snapshot_id
    || !(await publicationAdmission(client,canonical,settings,'edit')).allowed) return false;
  if (!(await client.query(`SELECT 1 FROM publications p WHERE p.id=$1 AND ${delivered}`, [canonical.id])).rows.length) return false;
  const duplicate = (await client.query<Publication & { canonical_story_id: string | null; duplicate_story_id: string | null }>(`
    SELECT d.*,snap.content,coalesce(da.canonical_story_id,dm.canonical_story_id,d.story_id) AS duplicate_story_id,
      coalesce(ca.canonical_story_id,cm.canonical_story_id,c.story_id) AS canonical_story_id
    FROM publication_replacements r JOIN publications d ON d.id=r.duplicate_publication_id
    JOIN publication_snapshots snap ON snap.id=d.snapshot_id JOIN publications c ON c.id=r.canonical_publication_id
    LEFT JOIN story_publication_aliases da ON da.publication_id=d.id LEFT JOIN story_merges dm ON dm.merged_story_id=d.story_id
    LEFT JOIN story_publication_aliases ca ON ca.publication_id=c.id LEFT JOIN story_merges cm ON cm.merged_story_id=c.story_id
    WHERE d.id=$1 AND r.status='pending' AND r.canonical_publication_id=$2 AND r.canonical_snapshot_id=$3
      AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||d.id::text)
      AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=d.id
        AND (a.status IN ('running','unknown') OR (a.operation='delete' AND a.status='succeeded')))
    FOR UPDATE OF d,r`,[publication.id,proof.canonicalPublicationId,proof.canonicalSnapshotId])).rows[0];
  if (!duplicate || duplicate.status!=='published' || duplicate.pending_snapshot_id
    || duplicate.message_id!==publication.message_id || duplicate.destination_id!==publication.destination_id
    || duplicate.snapshot_id!==publication.snapshot_id || duplicate.bot_id!==canonical.bot_id
    || duplicate.destination_id!==canonical.destination_id || !duplicate.duplicate_story_id || !duplicate.canonical_story_id) return false;
  return (await sameStoryIds(client,duplicate.canonical_story_id)).includes(duplicate.duplicate_story_id);
}
