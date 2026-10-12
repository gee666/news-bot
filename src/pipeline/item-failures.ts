import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';
import { ProcessingYield } from './processing-slice.js';

// Failed input cannot withhold a story that still has a usable current report.
export const blockedStoriesCte = `blocked_stories(id) AS (
  SELECT s.id::text FROM stories s WHERE EXISTS(
    SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=s.id
      AND r.metadata @> '{"pipelineFailure":true}'::jsonb)
  AND NOT EXISTS(
    SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=s.id
      AND NOT (r.metadata @> '{"pipelineFailure":true}'::jsonb))
)`;

export async function existingItemFailures(batchId: string): Promise<Set<string>> {
  const rows = await db.query<{ revision_id: string }>(`SELECT DISTINCT s.revision_id FROM stage_state s
    JOIN item_revisions r ON r.id=s.revision_id WHERE s.batch_id=$1
    AND s.stage NOT LIKE 'embed:%' AND s.stage NOT LIKE 'match:%' AND (s.status='failed'
      OR (s.status='waiting' AND s.next_retry_at>now()))
    AND NOT ((coalesce(jsonb_typeof(r.metadata->'pipelineExtraction')='array',false)
      OR EXISTS(SELECT 1 FROM stage_state done WHERE done.revision_id=r.id AND done.stage LIKE 'extract:%'
        AND done.status='completed' AND jsonb_typeof(done.output)='array')) AND
      (s.stage='count' OR s.stage LIKE 'item_eligibility:%' OR s.stage LIKE 'extract:%' OR s.stage LIKE 'validate_split:%'))`, [batchId]);
  return new Set(rows.rows.map(row => row.revision_id));
}

/** Model failures belong to the revision, never to its siblings or enclosing batch. */
export async function itemWork(batchId: string, revisionId: string, failed: Set<string>, run: () => Promise<void>): Promise<void> {
  if (failed.has(revisionId)) return;
  try { await run(); } catch (error) {
    if (error instanceof ProcessingYield) throw error;
    // Only swallow persisted unit failures. Database errors must reach the batch boundary.
    const saved = await db.query<{ status: string }>(`SELECT status FROM stage_state
      WHERE batch_id=$1 AND revision_id=$2 AND status IN ('waiting','failed') LIMIT 1`, [batchId, revisionId]);
    if (!saved.rows.length) throw error;
    if (saved.rows[0]?.status === 'failed') await db.query(
      "UPDATE batch_items SET status='failed' WHERE batch_id=$1 AND revision_id=$2", [batchId, revisionId]);
    failed.add(revisionId);
  }
}

export async function completeBatchItems(batchId: string, client?: PoolClient, revisionId?: string): Promise<void> {
  const complete = async (client: PoolClient) => {
    await client.query(`UPDATE batch_items b SET status=CASE WHEN EXISTS(
      SELECT 1 FROM stage_state s WHERE s.batch_id=b.batch_id AND s.revision_id=b.revision_id AND s.status='failed')
      THEN 'failed' ELSE 'completed' END WHERE batch_id=$1 AND status NOT IN ('rejected','failed')
      AND ($2::uuid IS NULL OR b.revision_id=$2)
      AND EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=b.batch_id AND s.revision_id=b.revision_id
        AND s.stage LIKE 'links:%' AND s.status='completed')
      AND (EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=b.batch_id AND s.revision_id=b.revision_id AND s.status='failed')
        OR NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=b.revision_id AND m.story_id IS NULL))
      AND NOT EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=b.batch_id AND s.revision_id=b.revision_id
        AND s.status IN ('pending','running','waiting'))`, [batchId, revisionId ?? null]);
    // A callback acknowledges only its revision, never the enclosing batch or untouched siblings.
    if (revisionId) return;
    await client.query(`UPDATE processing_batches SET
      status=CASE WHEN EXISTS(SELECT 1 FROM stage_state WHERE batch_id=$1 AND status IN ('pending','running','waiting'))
        OR EXISTS(SELECT 1 FROM batch_items WHERE batch_id=$1 AND status IN ('pending','processing')) THEN 'waiting' ELSE 'completed' END,
      completed_at=CASE WHEN EXISTS(SELECT 1 FROM stage_state WHERE batch_id=$1 AND status IN ('pending','running','waiting'))
        OR EXISTS(SELECT 1 FROM batch_items WHERE batch_id=$1 AND status IN ('pending','processing')) THEN NULL ELSE now() END,
      next_retry_at=coalesce((SELECT min(coalesce(next_retry_at,now()+interval '1 second')) FROM stage_state
        WHERE batch_id=$1 AND status IN ('pending','running','waiting')),
        CASE WHEN EXISTS(SELECT 1 FROM batch_items WHERE batch_id=$1 AND status IN ('pending','processing')) THEN now()+interval '1 second' END),
      error_code=CASE WHEN EXISTS(SELECT 1 FROM stage_state WHERE batch_id=$1 AND status='failed')
        THEN 'partial_unit_failure' ELSE NULL END,waiting_reason=NULL WHERE id=$1`, [batchId]);
  };
  if (client) await complete(client); else await transaction(complete);
}
