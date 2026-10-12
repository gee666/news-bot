-- The first generation-v10 deployment sent an unsupported URI schema format.
-- Retry only invalid requests from that rollout; preserve successful receipts and audits.
WITH affected AS (
  UPDATE stage_state SET status='pending',attempts=0,next_retry_at=NULL,error_code=NULL,
    waiting_reason=NULL,outcome_unknown=false,updated_at=now()
  WHERE stage LIKE 'research:generation-v10:%' AND error_code='invalid_request'
    AND updated_at >= (SELECT applied_at FROM schema_migrations WHERE name='190_automatic_processing.sql')
  RETURNING batch_id
)
UPDATE processing_batches SET next_retry_at=NULL,status='queued',error_code=NULL,waiting_reason=NULL
WHERE completed_at IS NULL AND id IN (SELECT batch_id FROM affected);
DELETE FROM operational_state
WHERE key LIKE 'pipeline_failed_story:%' AND value->>'errorCode'='invalid_request'
  AND updated_at >= (SELECT applied_at FROM schema_migrations WHERE name='190_automatic_processing.sql');
