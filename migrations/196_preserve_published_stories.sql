-- Source edits invalidate drafts, never already published stories. No schema additions.
CREATE OR REPLACE FUNCTION invalidate_edited_stories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_revision_id IS NOT NULL AND NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
    UPDATE stories SET status = 'processing', interest_stale = true, updated_at = now()
    WHERE id IN (SELECT story_id FROM story_mentions WHERE revision_id = OLD.current_revision_id)
      AND NOT EXISTS(SELECT 1 FROM publications p WHERE p.story_id=stories.id
        AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL)
      AND status <> 'rejected';
  END IF;
  RETURN NEW;
END;
$$;
