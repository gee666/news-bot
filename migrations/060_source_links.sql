-- Source-only messages contribute links without becoming separate news stories.
CREATE TABLE story_link_sources (
  link_id uuid NOT NULL REFERENCES item_links(id) ON DELETE CASCADE,
  story_id uuid NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  classification text NOT NULL CHECK (classification IN ('relevant', 'uncertain', 'irrelevant')),
  model_key text NOT NULL,
  model_version integer NOT NULL,
  prompt_version text NOT NULL,
  input_hash text NOT NULL,
  assessed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, story_id)
);
CREATE INDEX story_link_sources_story ON story_link_sources(story_id);
