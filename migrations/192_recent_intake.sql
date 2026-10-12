-- Use five nearest matching candidates instead of the old twenty-candidate default.
-- Preserve explicitly customized limits and all successful matching receipts.
UPDATE app_settings SET value=jsonb_set(value,'{matchCandidateLimit}','5'),updated_at=now()
WHERE value->>'matchCandidateLimit'='20';
UPDATE processing_batches SET settings_snapshot=jsonb_set(settings_snapshot,'{matchCandidateLimit}','5')
WHERE completed_at IS NULL AND manual_operation_id IS NULL AND settings_snapshot->>'matchCandidateLimit'='20';
