-- Bounded grouping can retry the oversized requests without replaying successful
-- extraction or touching publication identities. Request audits remain immutable.
WITH affected AS (
  UPDATE stage_state s SET status='pending',attempts=0,retry_epoch=retry_epoch+1,retry_epoch_start=0,
    next_retry_at=NULL,error_code=NULL,waiting_reason=NULL,outcome_unknown=false,updated_at=now()
  FROM processing_batches b
  WHERE b.id=s.batch_id AND b.completed_at IS NULL AND b.manual_operation_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||b.id::text)
    AND (s.stage LIKE 'match:grouping-v2:%' OR s.stage='consolidate:grouping-v2')
    AND s.status IN ('failed','waiting') AND s.error_code IN ('timeout','context_limit','invalid_output','invalid_request')
  RETURNING s.batch_id,s.revision_id,s.stage
), retired AS (
  -- A duplicate snapshot must not copy an old exhausted receipt back over the
  -- reset. Keep its counter and audit, but retire only failed historical work.
  UPDATE stage_state s SET status='skipped',next_retry_at=NULL,
    waiting_reason='Superseded by bounded grouping retry.',updated_at=now()
  FROM processing_batches b
  WHERE b.id=s.batch_id AND b.completed_at IS NOT NULL AND b.manual_operation_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||b.id::text)
    AND s.status IN ('failed','waiting')
    AND EXISTS(SELECT 1 FROM affected a WHERE a.revision_id=s.revision_id AND a.stage=s.stage)
  RETURNING s.id
), reopened AS (
  UPDATE batch_items bi SET status='pending',disposition_reason=NULL FROM affected a
  WHERE bi.batch_id=a.batch_id AND bi.revision_id=a.revision_id AND bi.status='failed'
    AND bi.disposition_reason IS DISTINCT FROM 'superseded_revision'
  RETURNING bi.batch_id
)
UPDATE processing_batches SET status='queued',next_retry_at=NULL,error_code=NULL,waiting_reason=NULL
WHERE id IN (SELECT batch_id FROM affected);
