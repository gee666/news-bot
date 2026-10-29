import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';
import { ProcessingYield } from './processing-slice.js';
import type { AppSettings } from '../settings.js';

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

/** SQL identifiers/placeholders are fixed by callers, never external input. */
export function dueBatchItems(batchIdSql:string):string {
  return `EXISTS(SELECT 1 FROM batch_items i WHERE i.batch_id=${batchIdSql} AND i.status IN ('pending','processing')
        AND NOT EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=i.batch_id AND s.revision_id=i.revision_id
          AND (s.status='failed' OR (s.status IN ('running','waiting') AND s.next_retry_at>now())))
        OR (i.batch_id=${batchIdSql} AND i.status IN ('pending','processing') AND EXISTS(SELECT 1 FROM story_mentions m
          WHERE m.revision_id=i.revision_id AND m.story_id IS NULL
            AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window'
            AND NOT EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=i.batch_id AND s.revision_id=i.revision_id
              AND (s.stage LIKE 'match:%:'||m.id::text OR s.stage LIKE 'embed:%:'||m.id::text)
              AND (s.status='failed' OR (s.status IN ('running','waiting') AND s.next_retry_at>now()))))))`;
}

/** Retain the original extraction and text, but give obsolete orphan reports an explicit terminal disposition. */
export async function expireUnassignedMentions(settings:AppSettings):Promise<void> {
  await transaction(async client => {
    await client.query(`UPDATE story_mentions m SET metadata=m.metadata||'{"disposition":"outside_collection_window"}'::jsonb
      FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
      WHERE m.revision_id=r.id AND m.story_id IS NULL
        AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window'
        AND greatest(i.collected_at,r.created_at)<now()-$1*interval '1 hour'
        AND NOT EXISTS(SELECT 1 FROM batch_items b JOIN processing_batches p ON p.id=b.batch_id
          WHERE b.revision_id=r.id AND p.manual_operation_id IS NOT NULL AND p.completed_at IS NULL)`,[settings.collectionWindowHours]);
    await client.query(`UPDATE batch_items b SET status='rejected',disposition_reason='outside_collection_window'
      WHERE status IN ('pending','processing') AND EXISTS(SELECT 1 FROM story_mentions m
        WHERE m.revision_id=b.revision_id AND m.metadata->>'disposition'='outside_collection_window')
      AND NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=b.revision_id
        AND (m.story_id IS NOT NULL OR m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window'))`);
    await client.query(`UPDATE batch_items b SET status='rejected',disposition_reason='outside_collection_window'
      FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
      CROSS JOIN processing_batches p
      WHERE p.id=b.batch_id AND b.revision_id=r.id AND b.status IN ('pending','processing') AND p.manual_operation_id IS NULL
        AND greatest(i.collected_at,r.created_at)<now()-$1*interval '1 hour'
        AND NOT coalesce(jsonb_typeof(r.metadata->'pipelineExtraction')='array',false)
        AND NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM stage_state done WHERE done.revision_id=r.id AND done.stage LIKE 'extract:%'
          AND done.status='completed' AND jsonb_typeof(done.output)='array')
        AND NOT EXISTS(SELECT 1 FROM batch_items pin JOIN processing_batches manual ON manual.id=pin.batch_id
          WHERE pin.revision_id=r.id AND manual.manual_operation_id IS NOT NULL AND manual.completed_at IS NULL)`,[settings.collectionWindowHours]);
    await client.query(`UPDATE stage_state s SET status='skipped',next_retry_at=NULL,updated_at=now()
      WHERE status IN ('pending','running','waiting','failed') AND EXISTS(SELECT 1 FROM batch_items b
        WHERE b.batch_id=s.batch_id AND b.revision_id=s.revision_id AND b.disposition_reason='outside_collection_window')`);
  });
}

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
        OR NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=b.revision_id AND m.story_id IS NULL
          AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window'))
      AND NOT EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=b.batch_id AND s.revision_id=b.revision_id
        AND s.status IN ('pending','running','waiting'))`, [batchId, revisionId ?? null]);
    // A callback acknowledges only its revision, never the enclosing batch or untouched siblings.
    if (revisionId) return;
    await client.query(`WITH work AS (
      SELECT ${dueBatchItems('$1')} AS ready_items,
        EXISTS(SELECT 1 FROM batch_items WHERE batch_id=$1 AND status IN ('pending','processing')) AS unfinished_items,
        (SELECT min(coalesce(next_retry_at,now()+interval '1 second')) FROM stage_state
          WHERE batch_id=$1 AND status IN ('pending','running','waiting')) AS stage_retry,
        (SELECT max(a.next_retry_at) FROM request_attempts a WHERE a.provider='telegram-user'
          AND EXISTS(SELECT 1 FROM processing_batches automatic WHERE automatic.id=$1 AND automatic.manual_operation_id IS NULL)
          AND (a.operation=$1::text OR a.next_retry_at>now())
          AND (a.status IN ('retryable','unknown') OR (a.error_code='telegram_rate_limit' AND a.next_retry_at>now()))
          AND a.next_retry_at IS NOT NULL
          AND NOT EXISTS(SELECT 1 FROM request_attempts done WHERE done.provider=a.provider AND done.operation=$1::text
            AND (done.status IN ('succeeded','failed') OR (done.status='unknown' AND done.next_retry_at IS NULL)))
          AND NOT EXISTS(SELECT 1 FROM request_attempts newer WHERE newer.provider=a.provider AND newer.operation=a.operation
            AND newer.attempt_number>a.attempt_number)) AS connector_retry
    ) UPDATE processing_batches SET
      status=CASE WHEN work.unfinished_items OR work.stage_retry IS NOT NULL OR work.connector_retry IS NOT NULL THEN 'waiting' ELSE 'completed' END,
      completed_at=CASE WHEN work.unfinished_items OR work.stage_retry IS NOT NULL OR work.connector_retry IS NOT NULL THEN NULL ELSE now() END,
      next_retry_at=CASE WHEN work.ready_items THEN now()+interval '1 second'
        ELSE least(work.stage_retry,work.connector_retry) END,
      error_code=CASE WHEN EXISTS(SELECT 1 FROM stage_state WHERE batch_id=$1 AND status='failed') THEN 'partial_unit_failure'
        WHEN EXISTS(SELECT 1 FROM batch_sources WHERE batch_id=$1 AND status='failed') THEN 'partial_source_failure' ELSE NULL END,
      waiting_reason=CASE WHEN work.connector_retry IS NOT NULL AND NOT work.ready_items THEN 'Telegram collection is waiting for its saved retry time.' ELSE NULL END
      FROM work WHERE id=$1`, [batchId]);
  };
  if (client) await complete(client); else await transaction(complete);
}
