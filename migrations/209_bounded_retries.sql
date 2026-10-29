ALTER TABLE processing_batches
  ADD COLUMN retry_attempts integer NOT NULL DEFAULT 0 CHECK(retry_attempts>=0),
  ADD COLUMN last_served_at timestamptz NOT NULL DEFAULT now();
UPDATE processing_batches SET last_served_at=started_at;

-- Adopt the new default without overwriting an operator's non-default attempt limit.
UPDATE app_settings SET value=jsonb_set(value,'{requestMaxAttempts}','3'::jsonb),updated_at=now()
WHERE value->>'requestMaxAttempts'='5';

-- Previously denied orphan edits must not occupy the oldest-first slot after restart.
INSERT INTO operational_state(key,value)
SELECT 'publication_edit_settled:'||p.id::text||':'||p.pending_snapshot_id::text,
  jsonb_build_object('snapshotId',p.pending_snapshot_id,'status','failed','errorCode','publication_admission_story_ineligible')
FROM publications p WHERE p.pending_snapshot_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM operational_state o WHERE o.key='publication_admission:'||p.id::text||':'||p.pending_snapshot_id::text||':story_ineligible')
  AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit' AND a.status IN ('running','unknown'))
ON CONFLICT(key) DO NOTHING;
UPDATE publications p SET pending_snapshot_id=NULL,updated_at=now()
WHERE p.pending_snapshot_id IS NOT NULL AND EXISTS(SELECT 1 FROM operational_state o
  WHERE o.key='publication_edit_settled:'||p.id::text||':'||p.pending_snapshot_id::text);
UPDATE request_attempts a SET status='failed',finished_at=now(),
  error_code=CASE WHEN error_code='telegram_rate_limit' AND next_retry_at>now() THEN error_code ELSE 'publication_admission_story_ineligible' END,
  next_retry_at=CASE WHEN error_code='telegram_rate_limit' AND next_retry_at>now() THEN next_retry_at ELSE NULL END
WHERE a.operation='edit' AND a.status='retryable' AND EXISTS(SELECT 1 FROM operational_state o
  WHERE o.key='publication_edit_settled:'||a.publication_id::text||':'||(a.response_metadata->>'snapshotId'));
UPDATE processing_batches SET settings_snapshot=jsonb_set(settings_snapshot,'{requestMaxAttempts}','3'::jsonb)
WHERE completed_at IS NULL AND settings_snapshot->>'requestMaxAttempts'='5';
