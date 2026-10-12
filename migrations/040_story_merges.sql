-- Publication identities outlive retained raw stories; keep aliases after cleanup.
CREATE TABLE story_merges (
  merged_story_id uuid PRIMARY KEY,
  canonical_story_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('same', 'update')),
  merged_at timestamptz NOT NULL DEFAULT now(),
  CHECK (merged_story_id <> canonical_story_id)
);
CREATE INDEX story_merges_canonical ON story_merges(canonical_story_id);

-- Cleanup nulls publications.story_id and snapshot.story_id when deleting empty losers.
-- Preserve the publication-to-canonical relationship before that can happen.
CREATE TABLE story_publication_aliases (
  publication_id uuid PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE,
  original_story_id uuid NOT NULL,
  canonical_story_id uuid NOT NULL
);
CREATE INDEX story_publication_aliases_canonical ON story_publication_aliases(canonical_story_id);

-- Historical assessments are evidence, not current verification of the merged text.
CREATE TABLE story_merge_evidence (
  merged_story_id uuid NOT NULL,
  canonical_story_id uuid NOT NULL,
  evidence_id uuid NOT NULL REFERENCES evidence_documents(id) ON DELETE CASCADE,
  role text NOT NULL,
  assessment text,
  verified_at timestamptz,
  PRIMARY KEY (merged_story_id,evidence_id)
);
