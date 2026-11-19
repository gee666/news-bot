import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppSettings } from '../settings.js';
import { publicationThreadEdges } from '../pipeline/generation-context.js';
import { publicationAdmission } from './freshness.js';
import { confirmedDelivery, delivered, sameStoryIds } from './navigation.js';
import { publicationEditSelect, supersedeAttempts, type Publication } from './store.js';
import { takeReplacementEvents } from './thread-events.js';

const receiptJoin = `JOIN publication_snapshots snap ON snap.id=p.snapshot_id
  JOIN judgments j ON j.id=snap.generation_id AND j.story_id=snap.story_id AND j.stage='generation_research'
    AND j.result->>'headline'=snap.content->>'headline' AND j.result->>'summary'=snap.content->>'details'`;
const coveredIds = z.array(z.uuid());
const effectiveStory = 'coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)';
const identityJoins = `LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
  LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id`;
// Start from indexed story / alias / merge keys, never all posts in the channel.
const componentPosts = `component_posts(id) AS (
  SELECT id FROM publications WHERE story_id=ANY($3::uuid[])
  UNION SELECT publication_id FROM story_publication_aliases WHERE canonical_story_id=ANY($3::uuid[])
  UNION SELECT p.id FROM story_merges m JOIN publications p ON p.story_id=m.merged_story_id
    WHERE m.canonical_story_id=ANY($3::uuid[])
)`;

/** Identity alone cannot authorize deleting a newly joined publication branch.
 * Check the receipt pinned to this exact survivor, within its bot/destination.
 * Legacy receipts may prove ordinary directed ancestry, never a same-only join. */
export async function replacementCoversGroup(client: Pick<PoolClient, 'query'>, publicationId: string,
  snapshotId: string, storyIds: readonly string[]): Promise<boolean> {
  const result = await client.query<{ coverage: unknown; required_story_ids: string[]; ancestor_story_ids: string[] }>(`
    WITH RECURSIVE ${publicationThreadEdges}, ${componentPosts}, canonical AS (
      SELECT p.story_id,p.bot_id,p.destination_id,j.result->'coveredPublishedStoryIds' AS coverage
      FROM publications p ${receiptJoin}
      WHERE p.id=$1 AND p.snapshot_id=$2
    ), ancestors(id) AS (
      SELECT story_id FROM canonical WHERE coverage IS NULL OR coverage='null'::jsonb
      UNION SELECT e.previous_story_id FROM ancestors a JOIN publication_thread_edges e ON e.story_id=a.id
    ) SELECT c.coverage,ARRAY(
      SELECT DISTINCT p.story_id FROM component_posts cp JOIN publications p ON p.id=cp.id ${identityJoins}
      WHERE ${effectiveStory}=ANY($3::uuid[])
        AND p.destination_id=c.destination_id AND p.bot_id=c.bot_id AND p.story_id<>c.story_id
        AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL
    ) AS required_story_ids,ARRAY(SELECT id FROM ancestors) AS ancestor_story_ids FROM canonical c`,
  [publicationId, snapshotId, storyIds]);
  const row = result.rows[0];
  if (!row) return false;
  const coverage = coveredIds.safeParse(row.coverage);
  if (coverage.success) return row.required_story_ids.every(id => coverage.data.includes(id));
  return row.coverage == null && row.required_story_ids.every(id => row.ancestor_story_ids.includes(id));
}

/** Caller holds the history lock. Discover only exact old IDs from a confirmed survivor's pinned receipt. */
export async function prepareReplacements(client: PoolClient, destinationId: string, latestPublicationIds?: string[]): Promise<void> {
  const events = await takeReplacementEvents(client,destinationId,latestPublicationIds);
  const survivors = new Map<string, Set<string> | null>();
  for (const event of events) {
    if (!event.blocked_by) survivors.set(event.publication_id,null);
    else if (survivors.get(event.publication_id) !== null) {
      const old = survivors.get(event.publication_id) ?? new Set<string>();
      old.add(event.blocked_by);
      survivors.set(event.publication_id,old);
    }
  }
  for (const [id, restricted] of survivors) {
    const canonical = (await client.query<{ snapshot_id: string; effective_story_id: string; story_id: string; coverage: unknown }>(`
      SELECT p.snapshot_id,p.story_id,${effectiveStory} AS effective_story_id,j.result->'coveredPublishedStoryIds' AS coverage
      FROM publications p ${receiptJoin} ${identityJoins}
      WHERE p.id=$1 AND p.destination_id=$2 AND p.bot_id IS NOT NULL AND ${effectiveStory} IS NOT NULL
        AND p.format_version=1 AND p.pending_snapshot_id IS NULL AND ${delivered}
      FOR UPDATE OF p`, [id,destinationId])).rows[0];
    if (!canonical) continue;
    const parsed = coveredIds.safeParse(canonical.coverage);
    let covered: string[];
    if (parsed.success) covered = parsed.data;
    else if (canonical.coverage == null) {
      // Legacy receipts may prove only explicitly classified, directed ancestry.
      covered = (await client.query<{ id: string }>(`WITH RECURSIVE ${publicationThreadEdges}, ancestors(id) AS (
        SELECT previous_story_id FROM publication_thread_edges WHERE story_id=$1
        UNION SELECT e.previous_story_id FROM ancestors a JOIN publication_thread_edges e ON e.story_id=a.id
      ) SELECT id FROM ancestors`, [canonical.story_id])).rows.map(row => row.id);
    } else continue;
    if (!covered.length) continue;
    const same = await sameStoryIds(client,canonical.effective_story_id);
    if (!await replacementCoversGroup(client,id,canonical.snapshot_id,same)) continue;
    if ((await client.query(`WITH ${componentPosts} SELECT 1 FROM publications c
      JOIN component_posts cp ON cp.id<>c.id JOIN publications p ON p.id=cp.id ${identityJoins}
      WHERE c.id=$1 AND c.destination_id=$2 AND p.destination_id=c.destination_id AND p.bot_id=c.bot_id
        AND ${effectiveStory}=ANY($3::uuid[]) AND ${delivered} AND p.format_version=1 AND p.pending_snapshot_id IS NULL
        AND (p.published_at,p.id)>(c.published_at,c.id) LIMIT 1`, [id,destinationId,same])).rows.length) continue;
    const older = (await client.query<{ id: string; blocked: boolean }>(`SELECT p.id,
        NOT (${confirmedDelivery}) OR EXISTS(SELECT 1 FROM request_attempts a
          WHERE a.publication_id=p.id AND a.status IN ('running','unknown')) AS blocked
      FROM publications c JOIN publications p ON p.destination_id=c.destination_id AND p.bot_id=c.bot_id ${identityJoins}
      WHERE c.id=$1 AND p.story_id=ANY($2::uuid[]) AND ${effectiveStory}=ANY($3::uuid[])
        AND ($4::uuid[] IS NULL OR p.id=ANY($4)) AND (p.published_at,p.id)<(c.published_at,c.id)
        AND p.status='published' AND p.message_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||p.id::text)
        AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id AND r.status<>'pending')
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='delete'
          AND a.status IN ('running','unknown','succeeded'))
      ORDER BY p.id FOR UPDATE OF p`, [id,covered,same,restricted ? [...restricted] : null])).rows;
    for (const old of older) {
      if (old.blocked) {
        await client.query(`INSERT INTO publication_thread_events(kind,publication_id,destination_id,blocked_by)
          SELECT 'replacement',$1,$2,$3 WHERE NOT EXISTS(SELECT 1 FROM publication_thread_events
            WHERE kind='replacement' AND publication_id=$1 AND destination_id=$2 AND blocked_by=$3)`, [id,destinationId,old.id]);
        continue;
      }
      await supersedeAttempts(client,[old.id],'edit');
      await client.query('UPDATE publications SET pending_snapshot_id=NULL,updated_at=now() WHERE id=$1 AND pending_snapshot_id IS NOT NULL',[old.id]);
      await client.query(`INSERT INTO publication_replacements(duplicate_publication_id,canonical_publication_id,canonical_snapshot_id)
        VALUES($1,$2,$3) ON CONFLICT(duplicate_publication_id) DO UPDATE
        SET canonical_publication_id=EXCLUDED.canonical_publication_id,canonical_snapshot_id=EXCLUDED.canonical_snapshot_id
        WHERE publication_replacements.status='pending'`,[old.id,id,canonical.snapshot_id]);
    }
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
  const same = await sameStoryIds(client,duplicate.canonical_story_id);
  return same.includes(duplicate.duplicate_story_id)
    && await replacementCoversGroup(client, canonical.id, canonical.snapshot_id, same);
}
