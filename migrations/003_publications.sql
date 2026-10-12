CREATE TABLE publication_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
  content jsonb NOT NULL CHECK (
    jsonb_typeof(content) = 'object' AND
    content ?& ARRAY['headline', 'score', 'details', 'detailsKind', 'sources'] AND
    jsonb_typeof(content->'headline') = 'string' AND
    jsonb_typeof(content->'details') = 'string' AND
    jsonb_typeof(content->'score') = 'number' AND
    (content->>'score')::numeric BETWEEN 1 AND 10 AND
    content->>'detailsKind' IN ('summary', 'excerpt') AND
    jsonb_typeof(content->'sources') = 'array'
  ),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
  snapshot_id uuid NOT NULL REFERENCES publication_snapshots(id),
  destination_id text NOT NULL,
  message_id text,
  callback_id text NOT NULL UNIQUE CHECK (length(callback_id) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'sending', 'published', 'uncertain', 'failed')),
  current_view text NOT NULL DEFAULT 'collapsed'
    CHECK (current_view IN ('collapsed', 'details', 'sources')),
  current_page integer NOT NULL DEFAULT 0 CHECK (current_page >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'published' OR message_id IS NOT NULL),
  UNIQUE (destination_id, message_id)
);
CREATE UNIQUE INDEX publication_story_destination ON publications(story_id, destination_id)
WHERE story_id IS NOT NULL;
CREATE INDEX publications_retry ON publications(status, next_retry_at);

CREATE TABLE request_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_id uuid REFERENCES stage_state(id) ON DELETE CASCADE,
  publication_id uuid REFERENCES publications(id) ON DELETE CASCADE,
  provider text NOT NULL,
  operation text NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'retryable', 'failed', 'unknown')),
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  next_retry_at timestamptz,
  error_code text,
  response_metadata jsonb NOT NULL DEFAULT '{}',
  CHECK (num_nonnulls(stage_id, publication_id) <= 1)
);
CREATE INDEX request_attempts_retry ON request_attempts(status, next_retry_at);
