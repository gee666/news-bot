-- Freeze every text part before sending the canonical message. Part zero is canonical.
CREATE TABLE publication_text_parts (
  publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number>=0),
  snapshot_id uuid NOT NULL REFERENCES publication_snapshots(id),
  content jsonb NOT NULL,
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','running','retryable','failed','unknown','sent')),
  message_id text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  error_code text,
  deleted_at timestamptz,
  PRIMARY KEY(publication_id,part_number),
  CHECK(status<>'sent' OR message_id IS NOT NULL)
);
CREATE INDEX publication_text_parts_due ON publication_text_parts(next_retry_at) WHERE part_number>0 AND status IN ('prepared','retryable');
