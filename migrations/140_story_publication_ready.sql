-- No backfill: old completed history is not a publication trigger.
CREATE TABLE story_publication_ready (
  story_id uuid PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  content_version integer NOT NULL,
  profile_version integer NOT NULL,
  model_version integer NOT NULL,
  manual_operation_id uuid,
  manual_input_boundary jsonb,
  token uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK(status IN ('pending','prepared','withheld','manual')),
  reason text,
  ready_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX story_publication_ready_pending ON story_publication_ready(ready_at,story_id) WHERE status='pending';
