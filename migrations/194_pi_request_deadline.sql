-- A dead Pi stream must release the serial processor within five minutes.
-- Preserve custom deadlines, historical snapshots and explicit manual runs.
UPDATE app_settings SET value=jsonb_set(value,'{piTimeoutMs}','300000'),updated_at=now()
WHERE value->>'piTimeoutMs'='1200000';
UPDATE processing_batches SET settings_snapshot=jsonb_set(settings_snapshot,'{piTimeoutMs}','300000')
WHERE completed_at IS NULL AND manual_operation_id IS NULL AND settings_snapshot->>'piTimeoutMs'='1200000';
