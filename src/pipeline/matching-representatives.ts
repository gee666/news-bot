import type { PoolClient } from 'pg';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { publicationThreadEdges } from './generation-context.js';

/** Callers supply matching_roots(id) and matching_eligible(id), before privacy/ranking.
 * Collapse identity, not evidence: the selected ID still loads only its own full reports.
 * Merged owners are excluded by callers; their audit records never become live candidates.
 */
export const matchingRepresentatives = `${publicationThreadEdges}, matching_same_edges(a,b) AS (
  SELECT lower_story_id,upper_story_id FROM story_relations
    WHERE relation='same' AND provenance->>'quarantined' IS DISTINCT FROM 'true'
  UNION SELECT story_id,previous_story_id FROM publication_thread_edges
), matching_components(root,id) AS (
  SELECT id,id FROM matching_roots
  UNION SELECT c.root,CASE WHEN e.a=c.id THEN e.b ELSE e.a END
    FROM matching_components c JOIN matching_same_edges e ON e.a=c.id OR e.b=c.id
), matching_conflicts AS (
  SELECT DISTINCT c.root FROM matching_components c JOIN story_relations r ON r.lower_story_id=c.id
  JOIN matching_components other ON other.root=c.root AND other.id=r.upper_story_id
  WHERE r.relation<>'same'
), matching_representatives AS (
  SELECT DISTINCT ON(c.root) c.root,s.id
  FROM matching_components c JOIN matching_eligible eligible ON eligible.id=c.id JOIN stories s ON s.id=c.id
  -- Legacy contradictory components must be reclassified, not silently collapsed.
  WHERE c.id=c.root OR NOT EXISTS(SELECT 1 FROM matching_conflicts conflict WHERE conflict.root=c.root)
  ORDER BY c.root,s.created_at DESC,s.id DESC
)`;

/** Normalize audit IDs without making an old/quarantined edge live again.
 * Omitted IDs have no permitted current representative; callers may keep them as audit keys.
 */
export async function currentStoryRepresentatives(ids: readonly string[], settings: AppSettings,
  client: Pick<PoolClient, 'query'> = db): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await client.query<{ root: string; id: string }>(`WITH RECURSIVE
    matching_roots AS (SELECT DISTINCT unnest($1::uuid[]) AS id), matching_eligible AS (
      SELECT s.id FROM stories s WHERE s.status<>'rejected'
        AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
        AND EXISTS(SELECT 1 FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id
          WHERE m.story_id=s.id AND i.retention_at>=now()-$2*interval '1 day')
    ), ${matchingRepresentatives}
    SELECT root,id FROM matching_representatives representative
    WHERE $3::boolean OR NOT EXISTS(SELECT 1 FROM story_mentions m
      JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.id=r.item_id
      JOIN sources source ON source.id=i.source_id WHERE m.story_id=representative.id AND source.access<>'public')`,
  [ids,settings.retentionDays,process.env.ALLOW_PRIVATE_INFERENCE==='true']);
  return new Map(rows.rows.map(row => [row.root,row.id]));
}
