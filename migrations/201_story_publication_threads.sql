-- Publication ancestry must survive source revisions and moving reports to a new edition.
CREATE TABLE story_publication_threads (
  story_id uuid PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  previous_story_id uuid REFERENCES stories(id) ON DELETE SET NULL,
  CHECK (story_id IS DISTINCT FROM previous_story_id)
);
CREATE INDEX story_publication_threads_previous ON story_publication_threads(previous_story_id);
INSERT INTO story_publication_threads(story_id,previous_story_id)
SELECT DISTINCT ON (m.story_id) m.story_id,(m.metadata->>'previous_story_id')::uuid
FROM story_mentions m JOIN stories previous ON previous.id::text=m.metadata->>'previous_story_id'
WHERE m.story_id IS NOT NULL AND m.story_id<>previous.id
ORDER BY m.story_id,m.created_at,m.id;
