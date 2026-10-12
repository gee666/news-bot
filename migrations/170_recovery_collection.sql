-- A source attempt and item processing have separate lifecycles. A failed primary
-- source retries on a new intake, not on every processing checkpoint of this one.
ALTER TABLE processing_batches ADD COLUMN primary_collection_completed_at timestamptz;
