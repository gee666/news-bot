-- Collected snapshots can wait for processing without blocking the next collection slot.
ALTER TABLE processing_batches DROP CONSTRAINT processing_batches_status_check;
ALTER TABLE processing_batches ADD CONSTRAINT processing_batches_status_check
  CHECK(status IN ('queued','collecting','processing','waiting','completed','failed'));
ALTER TABLE processing_batches ADD COLUMN scheduled_slot timestamptz UNIQUE;
ALTER TABLE batch_items ADD COLUMN disposition_reason text;
