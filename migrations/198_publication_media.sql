ALTER TABLE publications ADD COLUMN media_status text NOT NULL DEFAULT 'none'
  CHECK (media_status IN ('none','pending','complete','failed','unknown'));
ALTER TABLE publications ADD COLUMN media_snapshot_id uuid REFERENCES publication_snapshots(id);
CREATE TABLE publication_media_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id uuid NOT NULL REFERENCES publications(id),
  batch_number integer NOT NULL CHECK (batch_number>=0),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','running','retryable','failed','unknown','sent')),
  attempt_count integer NOT NULL DEFAULT 0,
  error_code text,
  next_retry_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (publication_id,batch_number)
);
CREATE TABLE publication_media_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES publication_media_batches(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal>=0 AND ordinal<10),
  type text NOT NULL CHECK (type IN ('image','video')),
  mime_type text NOT NULL,
  digest text NOT NULL,
  data bytea,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  message_id text,
  deleted_at timestamptz,
  UNIQUE (batch_id,ordinal)
);
CREATE INDEX publication_media_due ON publication_media_batches(publication_id,next_retry_at)
  WHERE status IN ('prepared','retryable','running');
CREATE INDEX publication_media_expiry ON publication_media_items(expires_at) WHERE data IS NOT NULL;
