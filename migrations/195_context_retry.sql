-- Retry only context-limit story failures now handled by Pi. Keep request audits.
WITH reset AS (
  DELETE FROM operational_state WHERE key LIKE 'pipeline_failed_story:%' AND value->>'errorCode'='context_limit'
  RETURNING value->>'storyId' AS story_id
)
INSERT INTO operational_state(key,value)
SELECT 'digest_refresh:'||s.id::text,jsonb_build_object('storyId',s.id) FROM stories s JOIN reset r ON s.id::text=r.story_id
WHERE EXISTS(SELECT 1 FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id WHERE m.story_id=s.id)
ON CONFLICT(key) DO NOTHING;
