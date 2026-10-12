CREATE TABLE source_link_processing (
  revision_id uuid PRIMARY KEY REFERENCES item_revisions(id) ON DELETE CASCADE,
  processing_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('source_only','excluded','other','oversized')),
  processed_at timestamptz NOT NULL DEFAULT now()
);
