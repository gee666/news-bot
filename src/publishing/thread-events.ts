import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { publicationThreadEdges } from '../pipeline/generation-context.js';
import { verifiedSameEdges } from './navigation.js';

// A blocked exact candidate wakes as soon as its old post's local receipt settles.
const unblocked = `(e.blocked_by IS NULL OR NOT EXISTS(SELECT 1 FROM request_attempts a
  WHERE a.publication_id=e.blocked_by AND a.status IN ('running','unknown')) AND NOT EXISTS(
  SELECT 1 FROM publication_media_batches b WHERE b.publication_id=e.blocked_by AND b.status IN ('prepared','retryable','running'))
  AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.id=e.blocked_by AND p.media_status='pending'))`;

export async function hasThreadEvents(destinationId: string, selected?: string[]): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM publication_thread_events e WHERE e.kind='graph'
    OR (e.destination_id=$1 AND (e.kind='navigation' OR ($2::uuid[] IS NULL OR e.publication_id=ANY($2)))
      AND ${unblocked}) LIMIT 1`, [destinationId, selected ?? null])).rows.length > 0;
}

export async function takeReplacementEvents(client: PoolClient, destinationId: string, selected?: string[]) {
  return (await client.query<{ publication_id: string; blocked_by: string | null }>(`DELETE FROM publication_thread_events
    WHERE id IN (SELECT e.id FROM publication_thread_events e WHERE e.kind='replacement' AND e.destination_id=$1
      AND ($2::uuid[] IS NULL OR e.publication_id=ANY($2)) AND ${unblocked} ORDER BY e.id LIMIT 100)
    RETURNING publication_id,blocked_by`, [destinationId, selected ?? null])).rows;
}

/** Expand a changed same component and its related neighbors, not the channel history.
 * Graph changes are global; fan them into independent destination-specific work. */
export async function fanOutNavigation(client: PoolClient): Promise<void> {
  await client.query(`WITH RECURSIVE ${publicationThreadEdges}, ${verifiedSameEdges},
    consumed AS (DELETE FROM publication_thread_events WHERE id IN (
      SELECT id FROM publication_thread_events WHERE kind='graph' ORDER BY id LIMIT 200) RETURNING story_id),
    changed(id) AS (
      SELECT story_id FROM consumed UNION
      SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END FROM changed c JOIN edges e ON e.a=c.id OR e.b=c.id
    ), roots(id) AS (
      SELECT id FROM changed UNION
      SELECT CASE WHEN r.lower_story_id=c.id THEN r.upper_story_id ELSE r.lower_story_id END
      FROM changed c JOIN story_relations r ON r.lower_story_id=c.id OR r.upper_story_id=c.id
      WHERE r.relation='related' AND r.provenance->>'quarantined' IS DISTINCT FROM 'true'
    ), affected(id) AS (
      SELECT id FROM roots UNION
      SELECT CASE WHEN e.a=c.id THEN e.b ELSE e.a END FROM affected c JOIN edges e ON e.a=c.id OR e.b=c.id
    ) INSERT INTO publication_thread_events(kind,publication_id,destination_id)
      SELECT 'navigation',p.id,p.destination_id FROM affected a JOIN publications p ON p.story_id=a.id
      WHERE p.status='published' AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL`);
}

export async function takeNavigationEvents(client: PoolClient, destinationId: string): Promise<string[]> {
  const result = await client.query<{ publication_id: string }>(`WITH consumed AS (
    DELETE FROM publication_thread_events WHERE id IN (SELECT id FROM publication_thread_events
      WHERE kind='navigation' AND destination_id=$1 ORDER BY id LIMIT 100) RETURNING publication_id
  ) SELECT DISTINCT publication_id FROM consumed`, [destinationId]);
  return result.rows.map(row => row.publication_id);
}
