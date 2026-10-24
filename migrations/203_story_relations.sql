-- A previous edge is not proof of event identity. Keep it for audit/repair only.
ALTER TABLE story_publication_threads ADD COLUMN classification_version text;

CREATE TABLE story_relations (
  lower_story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  upper_story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  relation text NOT NULL CHECK (relation IN ('same','related','unrelated')),
  classifier_version text NOT NULL,
  provenance jsonb NOT NULL DEFAULT '{}',
  classified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lower_story_id,upper_story_id),
  CHECK (lower_story_id < upper_story_id)
);
CREATE INDEX story_relations_upper ON story_relations(upper_story_id);
CREATE INDEX story_relations_related ON story_relations(lower_story_id,upper_story_id) WHERE relation='related';
