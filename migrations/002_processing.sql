CREATE TABLE processing_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'processing', 'waiting', 'completed', 'failed')),
  cutoff_at timestamptz NOT NULL,
  settings_snapshot jsonb NOT NULL CHECK (jsonb_typeof(settings_snapshot) = 'object'),
  profile_version integer NOT NULL CHECK (profile_version > 0),
  model_version integer NOT NULL CHECK (model_version > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  next_retry_at timestamptz,
  waiting_reason text,
  error_code text
);
CREATE UNIQUE INDEX one_active_batch ON processing_batches ((true))
WHERE status IN ('collecting', 'processing', 'waiting');

CREATE TABLE batch_sources (
  batch_id uuid NOT NULL REFERENCES processing_batches(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id),
  cursor_before jsonb NOT NULL DEFAULT '{}',
  cursor_after jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  error_code text,
  PRIMARY KEY (batch_id, source_id)
);

CREATE TABLE batch_items (
  batch_id uuid NOT NULL REFERENCES processing_batches(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL REFERENCES item_revisions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'rejected', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id, revision_id)
);
CREATE INDEX batch_items_revision ON batch_items(revision_id);

CREATE TABLE stage_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES processing_batches(id) ON DELETE CASCADE,
  revision_id uuid REFERENCES item_revisions(id) ON DELETE CASCADE,
  story_id uuid REFERENCES stories(id) ON DELETE CASCADE,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'waiting', 'completed', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  input_hash text,
  output jsonb,
  next_retry_at timestamptz,
  waiting_reason text,
  error_code text,
  outcome_unknown boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(revision_id, story_id) = 1),
  UNIQUE NULLS NOT DISTINCT (batch_id, revision_id, story_id, stage)
);
CREATE INDEX stage_ready ON stage_state(batch_id, stage, status, next_retry_at);

CREATE TABLE judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid REFERENCES processing_batches(id) ON DELETE SET NULL,
  revision_id uuid REFERENCES item_revisions(id) ON DELETE CASCADE,
  mention_id uuid REFERENCES story_mentions(id) ON DELETE CASCADE,
  story_id uuid REFERENCES stories(id) ON DELETE CASCADE,
  stage text NOT NULL,
  input_hash text NOT NULL,
  model_key text NOT NULL,
  prompt_version text NOT NULL,
  profile_version integer,
  model_version integer,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX judgments_expiry ON judgments(expires_at);
CREATE INDEX judgments_story ON judgments(story_id);
