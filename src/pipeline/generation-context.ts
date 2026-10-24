/** Legacy edges and mention metadata are audit evidence, not verified event identity. */
export const publicationThreadEdges = `publication_thread_edges(story_id,previous_story_id) AS (
  SELECT t.story_id,t.previous_story_id FROM story_publication_threads t
  WHERE t.previous_story_id IS NOT NULL AND t.classification_version IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM story_relations r
      WHERE r.lower_story_id=least(t.story_id,t.previous_story_id)
        AND r.upper_story_id=greatest(t.story_id,t.previous_story_id)
        AND (r.relation<>'same' OR r.provenance->>'quarantined'='true'))
)`;

/** The current draft and every ancestor, with cycle protection and no thread-length cap. */
export const generationThread = `WITH RECURSIVE ${publicationThreadEdges}, generation_thread(id,path) AS (
  SELECT $1::uuid,ARRAY[$1::uuid]
  UNION ALL SELECT e.previous_story_id,t.path||e.previous_story_id
    FROM generation_thread t JOIN publication_thread_edges e ON e.story_id=t.id
    WHERE NOT e.previous_story_id=ANY(t.path)
), generation_story_ids AS (SELECT DISTINCT id FROM generation_thread)`;
