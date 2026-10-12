-- Manual runs use their own bounded membership while sharing the pipeline lease.
-- Keep the existing singleton rule for scheduled batches and add one for manual runs.
ALTER TABLE processing_batches ADD COLUMN manual_operation_id uuid UNIQUE;
DROP INDEX one_active_batch;
CREATE UNIQUE INDEX one_active_batch ON processing_batches ((true))
WHERE manual_operation_id IS NULL AND status IN ('collecting', 'processing', 'waiting');
CREATE UNIQUE INDEX one_active_manual_batch ON processing_batches ((true))
WHERE manual_operation_id IS NOT NULL AND status IN ('collecting', 'processing', 'waiting');
