-- Resolve only the outstanding legacy requests. Never resend an ambiguous message.
DELETE FROM publication_destination_reservations r USING publications p
WHERE r.publication_id=p.id AND (p.status='uncertain' OR EXISTS(
  SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status='unknown'));
UPDATE request_attempts a SET status='failed',error_code='legacy_unresolved',next_retry_at=NULL,finished_at=now()
WHERE a.status IN ('running','unknown') AND EXISTS(SELECT 1 FROM publications p WHERE p.id=a.publication_id
  AND (p.status='uncertain' OR EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status='unknown')));
UPDATE publications p SET status='failed',error_code='legacy_unresolved',next_retry_at=NULL,updated_at=now()
WHERE status='uncertain' OR EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status='unknown');
UPDATE publications SET media_status='failed' WHERE EXISTS(
  SELECT 1 FROM publication_media_batches b WHERE b.publication_id=publications.id AND b.status='unknown');
UPDATE publication_media_batches SET status='failed',error_code='legacy_unresolved',next_retry_at=NULL WHERE status='unknown';
DROP TABLE publication_navigation_parts;
DROP TABLE publication_text_parts;
DELETE FROM operational_state WHERE key LIKE 'publication_action:%';

-- Stamp the preparation inputs once, including navigation-only edit snapshots.
ALTER TABLE publication_snapshots ADD COLUMN story_version integer;
ALTER TABLE publication_snapshots ADD COLUMN generation_id uuid;
CREATE FUNCTION stamp_publication_inputs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT s.content_version,(SELECT j.id FROM judgments j WHERE j.story_id=s.id
    AND j.stage='generation_research' AND j.result->>'headline'=s.headline
    AND j.result->>'summary' IS NOT DISTINCT FROM s.summary ORDER BY j.created_at DESC,j.id DESC LIMIT 1)
    INTO NEW.story_version,NEW.generation_id FROM stories s WHERE s.id=NEW.story_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER publication_preparation_inputs BEFORE INSERT ON publication_snapshots
FOR EACH ROW EXECUTE FUNCTION stamp_publication_inputs();
