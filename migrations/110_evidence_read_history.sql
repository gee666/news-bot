-- Cache invalidation must not erase a failed read's story attribution.
ALTER TABLE story_evidence ADD COLUMN superseded_at timestamptz;
