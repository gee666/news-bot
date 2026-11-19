-- Append-only invalidations: delivery and graph writers never contend on a queue key
-- held by the history worker. Consuming an event and staging its work are atomic.
CREATE TABLE publication_thread_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('graph','navigation','replacement')),
  publication_id uuid,
  destination_id text,
  story_id uuid,
  blocked_by uuid,
  queued_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind='graph' AND story_id IS NOT NULL AND publication_id IS NULL AND destination_id IS NULL)
    OR (kind<>'graph' AND story_id IS NULL AND publication_id IS NOT NULL AND destination_id IS NOT NULL)),
  CHECK (blocked_by IS NULL OR kind='replacement')
);
CREATE INDEX publication_thread_events_work ON publication_thread_events(kind,destination_id,id);

CREATE FUNCTION enqueue_publication_graph(story uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO publication_thread_events(kind,story_id) SELECT 'graph',story WHERE story IS NOT NULL;
$$;

CREATE FUNCTION enqueue_publication_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_delivered boolean := false;
  new_delivered boolean := false;
  identity_changed boolean := false;
BEGIN
  IF TG_OP<>'INSERT' THEN
    old_delivered := OLD.status='published' AND OLD.message_id IS NOT NULL AND OLD.published_at IS NOT NULL;
  END IF;
  IF TG_OP<>'DELETE' THEN
    new_delivered := NEW.status='published' AND NEW.message_id IS NOT NULL AND NEW.published_at IS NOT NULL;
  END IF;
  IF TG_OP='UPDATE' THEN
    identity_changed := (OLD.story_id,OLD.destination_id,OLD.bot_id,OLD.message_id,OLD.published_at,OLD.delivery_kind,OLD.media_status)
      IS DISTINCT FROM (NEW.story_id,NEW.destination_id,NEW.bot_id,NEW.message_id,NEW.published_at,NEW.delivery_kind,NEW.media_status);
    IF NOT identity_changed AND (OLD.status,OLD.snapshot_id,OLD.pending_snapshot_id,OLD.format_version)
      IS NOT DISTINCT FROM (NEW.status,NEW.snapshot_id,NEW.pending_snapshot_id,NEW.format_version) THEN RETURN NULL; END IF;
  END IF;
  IF old_delivered AND (NOT new_delivered OR identity_changed) THEN
    PERFORM enqueue_publication_graph(OLD.story_id);
  END IF;
  IF new_delivered THEN
    IF NOT old_delivered OR identity_changed OR (OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
      AND (SELECT content->>'headline' FROM publication_snapshots WHERE id=OLD.snapshot_id)
        IS DISTINCT FROM (SELECT content->>'headline' FROM publication_snapshots WHERE id=NEW.snapshot_id)) THEN
      PERFORM enqueue_publication_graph(NEW.story_id);
    END IF;
    -- A pending edit blocks replacement. Its settlement (success or failure) wakes work.
    IF NEW.pending_snapshot_id IS NULL THEN
      INSERT INTO publication_thread_events(kind,publication_id,destination_id)
        VALUES ('navigation',NEW.id,NEW.destination_id),('replacement',NEW.id,NEW.destination_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER publication_delivery_events AFTER INSERT OR DELETE OR UPDATE OF
  story_id,destination_id,bot_id,message_id,published_at,delivery_kind,media_status,status,snapshot_id,pending_snapshot_id,format_version
  ON publications FOR EACH ROW EXECUTE FUNCTION enqueue_publication_delivery();

-- A negative pair is normally inert. It matters if it masks a classified legacy
-- edge, or excludes a related link inherited across verified same-event editions.
CREATE FUNCTION publication_negative_conflict(a uuid,b uuid,quarantined boolean) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM story_publication_threads t WHERE t.classification_version IS NOT NULL
    AND ((t.story_id=a AND t.previous_story_id=b) OR (t.story_id=b AND t.previous_story_id=a)))
  OR (NOT COALESCE(quarantined,false) AND CASE WHEN NOT EXISTS (
    SELECT 1 FROM (VALUES (a),(b)) endpoints(id) WHERE NOT EXISTS (
      SELECT 1 FROM story_relations r WHERE r.relation IN ('same','related')
        AND (r.lower_story_id=endpoints.id OR r.upper_story_id=endpoints.id)
    ) AND NOT EXISTS (
      SELECT 1 FROM story_publication_threads t WHERE t.classification_version IS NOT NULL
        AND (t.story_id=endpoints.id OR t.previous_story_id=endpoints.id)
    )
  ) THEN EXISTS (
    WITH RECURSIVE component(root,id) AS (
      VALUES (a,a),(b,b)
      UNION
      SELECT c.root,n.id FROM component c CROSS JOIN LATERAL (
        SELECT CASE WHEN r.lower_story_id=c.id THEN r.upper_story_id ELSE r.lower_story_id END AS id
        FROM story_relations r WHERE r.relation='same' AND r.provenance->>'quarantined' IS DISTINCT FROM 'true'
          AND (r.lower_story_id=c.id OR r.upper_story_id=c.id)
        UNION ALL
        SELECT CASE WHEN t.story_id=c.id THEN t.previous_story_id ELSE t.story_id END
        FROM story_publication_threads t WHERE t.previous_story_id IS NOT NULL AND t.classification_version IS NOT NULL
          AND (t.story_id=c.id OR t.previous_story_id=c.id)
          AND NOT EXISTS(SELECT 1 FROM story_relations r WHERE r.lower_story_id=least(t.story_id,t.previous_story_id)
            AND r.upper_story_id=greatest(t.story_id,t.previous_story_id)
            AND (r.relation<>'same' OR r.provenance->>'quarantined'='true'))
      ) n
    ) SELECT 1 FROM component l JOIN story_relations r ON r.lower_story_id=l.id OR r.upper_story_id=l.id
      JOIN component h ON h.id=CASE WHEN r.lower_story_id=l.id THEN r.upper_story_id ELSE r.lower_story_id END
      WHERE l.root=a AND h.root=b AND r.relation='related' AND r.provenance->>'quarantined' IS DISTINCT FROM 'true'
  ) ELSE false END);
$$;

CREATE FUNCTION enqueue_publication_relation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='story_relations' THEN
    IF TG_OP='UPDATE' AND (OLD.lower_story_id,OLD.upper_story_id,OLD.relation,OLD.provenance->>'quarantined' IS NOT DISTINCT FROM 'true',
      CASE WHEN OLD.relation='related' THEN OLD.provenance->>'origin' END,
      CASE WHEN OLD.relation='related' THEN OLD.provenance->>'relatedPromptVersion' END) IS NOT DISTINCT FROM
      (NEW.lower_story_id,NEW.upper_story_id,NEW.relation,NEW.provenance->>'quarantined' IS NOT DISTINCT FROM 'true',
      CASE WHEN NEW.relation='related' THEN NEW.provenance->>'origin' END,
      CASE WHEN NEW.relation='related' THEN NEW.provenance->>'relatedPromptVersion' END) THEN RETURN NULL; END IF;
    IF TG_OP<>'INSERT' AND ((OLD.relation IN ('same','related') AND OLD.provenance->>'quarantined' IS DISTINCT FROM 'true')
      OR publication_negative_conflict(OLD.lower_story_id,OLD.upper_story_id,OLD.provenance->>'quarantined'='true')) THEN
      PERFORM enqueue_publication_graph(OLD.lower_story_id); PERFORM enqueue_publication_graph(OLD.upper_story_id);
      IF TG_OP='DELETE' OR (OLD.lower_story_id,OLD.upper_story_id)=(NEW.lower_story_id,NEW.upper_story_id) THEN RETURN NULL; END IF;
    END IF;
    IF TG_OP<>'DELETE' AND ((NEW.relation IN ('same','related') AND NEW.provenance->>'quarantined' IS DISTINCT FROM 'true')
      OR publication_negative_conflict(NEW.lower_story_id,NEW.upper_story_id,NEW.provenance->>'quarantined'='true')) THEN
      PERFORM enqueue_publication_graph(NEW.lower_story_id); PERFORM enqueue_publication_graph(NEW.upper_story_id);
    END IF;
  ELSE
    IF TG_OP='UPDATE' AND (OLD.story_id,OLD.previous_story_id,OLD.classification_version IS NOT NULL)
      IS NOT DISTINCT FROM (NEW.story_id,NEW.previous_story_id,NEW.classification_version IS NOT NULL) THEN RETURN NULL; END IF;
    IF TG_OP<>'INSERT' AND OLD.classification_version IS NOT NULL THEN
      PERFORM enqueue_publication_graph(OLD.story_id); PERFORM enqueue_publication_graph(OLD.previous_story_id);
    END IF;
    IF TG_OP<>'DELETE' AND NEW.classification_version IS NOT NULL THEN
      PERFORM enqueue_publication_graph(NEW.story_id); PERFORM enqueue_publication_graph(NEW.previous_story_id);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER publication_relation_events AFTER INSERT OR UPDATE OR DELETE ON story_relations
  FOR EACH ROW EXECUTE FUNCTION enqueue_publication_relation();
CREATE TRIGGER publication_ancestry_events AFTER INSERT OR UPDATE OR DELETE ON story_publication_threads
  FOR EACH ROW EXECUTE FUNCTION enqueue_publication_relation();

CREATE FUNCTION enqueue_publication_visibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  publication uuid;
BEGIN
  IF TG_TABLE_NAME='operational_state' THEN
    publication := substring(CASE WHEN TG_OP='DELETE' THEN OLD.key ELSE NEW.key END
      from '^publication_removal:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$')::uuid;
  ELSIF TG_TABLE_NAME='publication_replacements' THEN
    publication := CASE WHEN TG_OP='DELETE' THEN OLD.duplicate_publication_id ELSE NEW.duplicate_publication_id END;
  ELSE
    IF TG_OP='UPDATE' AND (OLD.status IN ('prepared','retryable','running'))=
      (NEW.status IN ('prepared','retryable','running')) THEN RETURN NULL; END IF;
    publication := CASE WHEN TG_OP='DELETE' THEN OLD.publication_id ELSE NEW.publication_id END;
  END IF;
  IF publication IS NOT NULL THEN
    PERFORM enqueue_publication_graph(p.story_id) FROM publications p WHERE p.id=publication AND p.status='published';
    IF TG_TABLE_NAME<>'publication_replacements' THEN
      INSERT INTO publication_thread_events(kind,publication_id,destination_id)
        SELECT kind,p.id,p.destination_id FROM publications p CROSS JOIN (VALUES ('replacement'),('navigation')) k(kind)
        WHERE p.id=publication AND p.status='published';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER publication_removed_events AFTER INSERT ON operational_state
  FOR EACH ROW WHEN (NEW.key LIKE 'publication_removal:%') EXECUTE FUNCTION enqueue_publication_visibility();
CREATE TRIGGER publication_restored_events AFTER DELETE ON operational_state
  FOR EACH ROW WHEN (OLD.key LIKE 'publication_removal:%') EXECUTE FUNCTION enqueue_publication_visibility();
CREATE TRIGGER publication_replacement_visibility_events AFTER INSERT OR DELETE ON publication_replacements
  FOR EACH ROW EXECUTE FUNCTION enqueue_publication_visibility();
CREATE TRIGGER publication_media_visibility_events AFTER INSERT OR UPDATE OF status OR DELETE ON publication_media_batches
  FOR EACH ROW EXECUTE FUNCTION enqueue_publication_visibility();

CREATE FUNCTION enqueue_publication_edit_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO publication_thread_events(kind,publication_id,destination_id)
    SELECT 'navigation',p.id,p.destination_id FROM publications p WHERE p.id=NEW.publication_id AND p.status='published';
  RETURN NULL;
END $$;
CREATE TRIGGER publication_edit_settlement_events AFTER UPDATE OF status ON request_attempts FOR EACH ROW
  WHEN (OLD.operation='edit' AND OLD.status IN ('running','unknown') AND NEW.status NOT IN ('running','unknown'))
  EXECUTE FUNCTION enqueue_publication_edit_settlement();

-- One-time upgrade: retain existing navigation cleanup and consider already pinned
-- successors. Subsequent runs read the event queue, never seed it from history.
INSERT INTO publication_thread_events(kind,publication_id,destination_id)
SELECT 'navigation',p.id,p.destination_id FROM publications p JOIN publication_snapshots s ON s.id=p.snapshot_id
WHERE p.status='published' AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL
  AND (s.content ? 'updatedTo' OR s.content->'sources' @> '[{"previousPublication":true}]'::jsonb
    OR s.content->'sources' @> '[{"relatedPublication":true}]'::jsonb
    OR s.content->'sources' @> '[{"unverifiedPublication":true}]'::jsonb);
INSERT INTO publication_thread_events(kind,story_id)
SELECT 'graph',story_id FROM (
  SELECT lower_story_id AS story_id FROM story_relations WHERE relation='related' AND provenance->>'quarantined' IS DISTINCT FROM 'true'
  UNION SELECT upper_story_id FROM story_relations WHERE relation='related' AND provenance->>'quarantined' IS DISTINCT FROM 'true'
) roots;
INSERT INTO publication_thread_events(kind,publication_id,destination_id)
SELECT 'replacement',p.id,p.destination_id FROM publications p JOIN publication_snapshots s ON s.id=p.snapshot_id
JOIN judgments j ON j.id=s.generation_id AND j.stage='generation_research'
WHERE p.status='published' AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL AND p.format_version=1
  AND (CASE WHEN jsonb_typeof(j.result->'coveredPublishedStoryIds')='array'
    THEN jsonb_array_length(j.result->'coveredPublishedStoryIds')>0 ELSE false END
    OR (j.result->>'coveredPublishedStoryIds' IS NULL AND EXISTS(SELECT 1 FROM story_publication_threads t
      WHERE t.story_id=p.story_id AND t.classification_version IS NOT NULL)));
