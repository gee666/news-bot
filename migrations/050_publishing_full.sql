-- Retain legacy callback columns for old snapshots and external readers only.
ALTER TABLE publications ALTER COLUMN callback_id SET DEFAULT replace(gen_random_uuid()::text, '-', '');
ALTER TABLE publications ADD COLUMN pending_snapshot_id uuid REFERENCES publication_snapshots(id);
ALTER TABLE publications ADD COLUMN format_version integer NOT NULL DEFAULT 0 CHECK (format_version IN (0, 1));
ALTER TABLE publications ADD COLUMN bot_id text;
UPDATE publications p SET bot_id = o.value->>'botId'
FROM operational_state o WHERE o.key='bot_verified' AND o.value->>'verified'='true'
  AND o.value->>'destinationId'=p.destination_id AND o.value->>'botId' ~ '^[0-9]+$';
CREATE TABLE publication_replacements (
  duplicate_publication_id uuid PRIMARY KEY REFERENCES publications(id),
  canonical_publication_id uuid NOT NULL REFERENCES publications(id),
  canonical_snapshot_id uuid NOT NULL REFERENCES publication_snapshots(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deleted','failed')),
  error_code text,
  next_retry_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (duplicate_publication_id <> canonical_publication_id)
);
