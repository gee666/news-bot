-- Multiple batches may have independent unit retry deadlines. The processor lease
-- still serializes dispatch; a waiting batch no longer owns the whole queue.
DROP INDEX IF EXISTS one_active_batch;
DROP INDEX IF EXISTS one_active_manual_batch;
CREATE INDEX IF NOT EXISTS stage_revision_receipts ON stage_state(revision_id,stage,updated_at DESC)
  WHERE revision_id IS NOT NULL;

-- Restore quarantined mentions without deleting their text, spans or request audits.
WITH RECURSIVE aliases(mention_id,story_id) AS (
  SELECT id,(metadata->>'quarantinedStoryId')::uuid FROM story_mentions
  WHERE story_id IS NULL AND metadata->>'quarantinedStoryId' IS NOT NULL
  UNION
  SELECT a.mention_id,m.canonical_story_id FROM aliases a JOIN story_merges m ON m.merged_story_id=a.story_id
), targets AS (
  SELECT a.mention_id,s.id FROM aliases a JOIN stories s ON s.id=a.story_id
  WHERE NOT EXISTS(SELECT 1 FROM story_merges m WHERE m.merged_story_id=s.id)
)
UPDATE story_mentions m SET story_id=t.id,metadata=m.metadata-'quarantinedStoryId'
FROM targets t WHERE m.id=t.mention_id;
UPDATE item_revisions SET metadata=metadata-'pipelineFailure' WHERE metadata ? 'pipelineFailure';

-- Keep historical operator records, but remove their authority to park work.
UPDATE operational_state SET key='retired:'||key
WHERE key LIKE 'pipeline_failed_item:%' OR key LIKE 'pipeline_failed_story:%'
  OR key LIKE 'release_story_deferral:%' OR key LIKE 'release_deferral_audit:%'
  OR key LIKE 'reprocess_scope:%' OR key LIKE 'recovery_batch:%'
  OR key LIKE 'stage_resume:%' OR key LIKE 'story_stage_recovery:%'
  OR key LIKE 'sibling_recovery:%' OR key LIKE 'item_recovery:%'
  OR key LIKE 'pipeline_batch_recovery:%';

-- Successful extraction, including [], stays final. Attempts now count failures only.
UPDATE stage_state SET attempts=0,retry_epoch_start=0 WHERE status='completed';
UPDATE stage_state SET status='skipped',next_retry_at=NULL
WHERE stage LIKE 'consolidate:%' OR (stage LIKE 'source_links:%' AND stage NOT LIKE 'source_links:item:%')
  OR ((stage='headlines' OR stage LIKE 'headlines:%') AND status IN ('pending','running','waiting','failed'));
UPDATE stage_state SET status='pending',attempts=0,retry_epoch_start=0,next_retry_at=NULL,updated_at=now()
WHERE status IN ('failed','waiting','pending','running') AND EXISTS(
  SELECT 1 FROM processing_batches b WHERE b.id=stage_state.batch_id AND (b.completed_at IS NULL
    OR EXISTS(SELECT 1 FROM batch_items bi JOIN source_items i ON i.current_revision_id=bi.revision_id
      WHERE bi.batch_id=b.id AND bi.status='failed')));
UPDATE batch_items b SET status='pending' WHERE status='failed' AND disposition_reason IS DISTINCT FROM 'superseded_revision'
  AND EXISTS(SELECT 1 FROM source_items i WHERE i.current_revision_id=b.revision_id);
-- Matching may have left mentions unassigned even in a formerly completed batch.
UPDATE batch_items b SET status='pending' WHERE EXISTS(
  SELECT 1 FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id
  WHERE m.revision_id=b.revision_id AND m.story_id IS NULL);
UPDATE processing_batches b SET status='queued',completed_at=NULL,next_retry_at=NULL,error_code=NULL,waiting_reason=NULL
WHERE completed_at IS NULL OR EXISTS(SELECT 1 FROM batch_items bi WHERE bi.batch_id=b.id AND bi.status IN ('pending','processing'));

-- Backfill immutable revision receipts from successful stages when older code only
-- saved the stage output. Never turn a confirmed-empty result into fresh extraction.
UPDATE item_revisions r SET metadata=metadata||jsonb_build_object(
  'pipelineExtraction',s.output,'pipelineExtractionVersion','events-v5','pipelineExtractionBatchId',s.batch_id::text)
FROM (SELECT DISTINCT ON(revision_id) revision_id,batch_id,output FROM stage_state
  WHERE stage='extract:events-v5' AND status='completed' AND jsonb_typeof(output)='array'
  ORDER BY revision_id,completed_at DESC NULLS LAST,id) s
WHERE r.id=s.revision_id AND NOT (r.metadata ? 'pipelineExtraction');

-- Old chunk failures used a separate exhausted budget. Expire those cache markers,
-- retaining their rows and request audits while the unit retry budget takes over.
UPDATE model_cache SET expires_at=now() WHERE kind='embedding' AND value->>'status' IN ('failed','submitted');

UPDATE operational_state SET value=(value-'repairApproval')||jsonb_build_object('attempts',0,'next',now()),updated_at=now()
WHERE (key LIKE 'consolidation_deferred:%' OR key LIKE 'source_link_deferred:%') AND value->>'status'='unresolved';
UPDATE operational_state SET value=value||jsonb_build_object('attempt',0,'phase','waiting','next',now()),updated_at=now()
WHERE key IN ('pipeline_digest','pipeline_reembedding') AND value->>'phase' IN ('failed','waiting','running');
INSERT INTO operational_state(key,value)
SELECT 'digest_refresh:'||s.id::text,jsonb_build_object('storyId',s.id) FROM stories s
WHERE s.status IN ('failed','pending','processing') AND EXISTS(
  SELECT 1 FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id WHERE m.story_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM story_merges m WHERE m.merged_story_id=s.id)
ON CONFLICT(key) DO NOTHING;
