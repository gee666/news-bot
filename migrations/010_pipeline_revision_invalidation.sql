-- Hide old display versions in the same transaction that saves an edited item.
CREATE FUNCTION invalidate_edited_stories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_revision_id IS NOT NULL AND NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
    UPDATE stories SET status = 'processing', interest_stale = true, updated_at = now()
    WHERE id IN (SELECT story_id FROM story_mentions WHERE revision_id = OLD.current_revision_id)
      AND status <> 'rejected';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_edited_stories AFTER UPDATE OF current_revision_id ON source_items
FOR EACH ROW EXECUTE FUNCTION invalidate_edited_stories();
