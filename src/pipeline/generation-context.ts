/** Legacy edges and mention metadata are audit evidence, not verified event identity. */
export const publicationThreadEdges = `publication_thread_edges(story_id,previous_story_id) AS (
  SELECT t.story_id,t.previous_story_id FROM story_publication_threads t
  WHERE t.previous_story_id IS NOT NULL AND t.classification_version IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM story_relations r
      WHERE r.lower_story_id=least(t.story_id,t.previous_story_id)
        AND r.upper_story_id=greatest(t.story_id,t.previous_story_id)
        AND (r.relation<>'same' OR r.provenance->>'quarantined'='true'))
)`;

/** All accepted same-event branches contribute material before replacement can delete
 * their old posts. UNION stops cycles without a thread-length cap. Related stories,
 * quarantined legacy relations and unclassified ancestry never contribute evidence. */
export const generationThread = `WITH RECURSIVE ${publicationThreadEdges}, generation_edges(a,b) AS (
  SELECT story_id,previous_story_id FROM publication_thread_edges
  UNION SELECT lower_story_id,upper_story_id FROM story_relations
    WHERE relation='same' AND provenance->>'quarantined' IS DISTINCT FROM 'true'
), generation_thread(id) AS (
  SELECT $1::uuid
  UNION SELECT CASE WHEN e.a=t.id THEN e.b ELSE e.a END
    FROM generation_thread t JOIN generation_edges e ON e.a=t.id OR e.b=t.id
), generation_story_ids AS (SELECT id FROM generation_thread)`;
