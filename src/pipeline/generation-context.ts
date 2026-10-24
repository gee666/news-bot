/** Durable lineage survives source revision retirement. Metadata covers older or in-flight links. */
export const publicationThreadEdges = `publication_thread_edges(story_id,previous_story_id) AS (
  SELECT story_id,previous_story_id FROM story_publication_threads WHERE previous_story_id IS NOT NULL
  UNION SELECT m.story_id,(m.metadata->>'previous_story_id')::uuid FROM story_mentions m
    WHERE m.story_id IS NOT NULL AND m.metadata ? 'previous_story_id'
      AND NOT EXISTS(SELECT 1 FROM story_publication_threads t WHERE t.story_id=m.story_id)
)`;

/** The current draft and every ancestor, with cycle protection and no thread-length cap. */
export const generationThread = `WITH RECURSIVE ${publicationThreadEdges}, generation_thread(id,path) AS (
  SELECT $1::uuid,ARRAY[$1::uuid]
  UNION ALL SELECT e.previous_story_id,t.path||e.previous_story_id
    FROM generation_thread t JOIN publication_thread_edges e ON e.story_id=t.id
    WHERE NOT e.previous_story_id=ANY(t.path)
), generation_story_ids AS (SELECT DISTINCT id FROM generation_thread)`;
