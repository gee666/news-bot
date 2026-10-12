-- Retire settings that no longer constrain Pi context or headline generation.
UPDATE app_settings SET value=value-'matchCandidateLimit'-'headlineBatchSize';
UPDATE processing_batches SET settings_snapshot=settings_snapshot-'matchCandidateLimit'-'headlineBatchSize';

-- Successful receipts remain available for immutable extraction and audit.
-- Removed stages cannot leave a live batch waiting on work nobody runs.
UPDATE stage_state SET status='skipped',next_retry_at=NULL,updated_at=now()
WHERE status IN ('pending','running','waiting','failed') AND (
  (story_id IS NOT NULL AND stage<>'extraction_affected')
  OR stage='count' OR stage LIKE 'item_eligibility:%' OR stage LIKE 'validate_split:%'
  OR (stage LIKE 'extract:%' AND stage<>'extract:events-v6')
  OR (stage LIKE 'links:%' AND stage<>'links:events-v6')
  OR stage LIKE 'source_links:item:%'
  OR (stage LIKE 'match:%' AND stage NOT LIKE 'match:grouping-v1:%')
);

-- Resume old link queues through the normal item path, not an operator action.
-- Reopen only the newest automatic snapshot of a current source-only revision.
WITH pending AS (
  SELECT DISTINCT ON (r.id) b.batch_id,r.id AS revision_id
  FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
  JOIN batch_items b ON b.revision_id=r.id JOIN processing_batches p ON p.id=b.batch_id
  WHERE (r.metadata->'pipelineExtraction'='[]'::jsonb OR EXISTS(
      SELECT 1 FROM stage_state s WHERE s.revision_id=r.id AND s.stage LIKE 'extract:%'
        AND s.status='completed' AND s.output='[]'::jsonb))
    AND p.manual_operation_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||p.id::text)
    AND EXISTS(SELECT 1 FROM item_links l WHERE l.revision_id=r.id)
    AND i.retention_at>=now()-coalesce((SELECT (value->>'retentionDays')::int FROM app_settings WHERE id=1),14)*interval '1 day'
  ORDER BY r.id,p.started_at DESC
)
UPDATE processing_batches p SET status='waiting',completed_at=NULL,next_retry_at=now(),error_code=NULL,waiting_reason=NULL
WHERE p.id IN (SELECT batch_id FROM pending)
  OR (p.completed_at IS NULL AND EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=p.id AND s.status='skipped'));

-- Digest used to drain associated intake even after its batch completed.
-- Reopen its newest automatic snapshot before retiring the old deferrals.
WITH pending AS (
  SELECT DISTINCT ON(r.id) b.batch_id FROM item_revisions r
  JOIN source_items i ON i.current_revision_id=r.id JOIN batch_items b ON b.revision_id=r.id
  JOIN processing_batches p ON p.id=b.batch_id
  WHERE p.manual_operation_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||p.id::text)
    AND i.retention_at>=now()-coalesce((SELECT (value->>'retentionDays')::int FROM app_settings WHERE id=1),14)*interval '1 day'
    AND EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id IS NOT NULL)
    AND NOT EXISTS(SELECT 1 FROM consolidation_intake done WHERE done.revision_id=r.id)
  ORDER BY r.id,p.started_at DESC
)
UPDATE processing_batches SET status='waiting',completed_at=NULL,next_retry_at=now(),error_code=NULL,waiting_reason=NULL
WHERE id IN(SELECT batch_id FROM pending);

-- Preserve legacy decisions as history, but stop scanning their retry trackers.
UPDATE operational_state SET value=value||'{"status":"resolved"}'::jsonb,updated_at=now()
WHERE key LIKE 'consolidation_deferred:%' OR key LIKE 'source_link_deferred:%';
UPDATE operational_state SET value=value-'failurePhase' WHERE key='pipeline_digest';
