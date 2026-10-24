-- Only Telegram-limit overflow and legacy continuation cleanup need separate messages.
-- Original event snapshots and media remain unchanged.
CREATE TABLE publication_navigation_parts (
  publication_id uuid NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  slot text NOT NULL,
  snapshot_id uuid NOT NULL REFERENCES publication_snapshots(id),
  content jsonb NOT NULL,
  message_id text,
  text_part_number integer,
  status text NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','running','sent','retryable','unknown','failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_retry_at timestamptz,
  error_code text,
  deleted_at timestamptz,
  PRIMARY KEY(publication_id,slot)
);
CREATE INDEX publication_navigation_parts_pending ON publication_navigation_parts(publication_id)
  WHERE status IN ('prepared','retryable','running','unknown');
