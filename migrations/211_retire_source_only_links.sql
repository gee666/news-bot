-- Only remove refresh requests attributable to a retired association transaction.
-- ON CONFLICT DO NOTHING preserved older marker timestamps, so uncertain ownership stays.
DELETE FROM operational_state o USING stories s
WHERE o.key='digest_refresh:'||s.id::text
  AND o.value=jsonb_build_object('storyId',s.id)
  AND EXISTS(SELECT 1 FROM story_link_sources sl
    WHERE sl.story_id=s.id AND sl.assessed_at=o.updated_at)
  -- Keep unfinished report work, including reports not captured in a sent boundary.
  AND NOT EXISTS(SELECT 1 FROM stage_state st
    WHERE st.status IN ('pending','running','waiting','failed') AND st.stage NOT LIKE 'source_links:%'
      AND (st.story_id=s.id OR EXISTS(SELECT 1 FROM story_mentions m
        JOIN source_items i ON i.current_revision_id=m.revision_id
        WHERE m.story_id=s.id AND m.revision_id=st.revision_id)))
  AND NOT EXISTS(SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=s.id
      AND NOT EXISTS(SELECT 1 FROM publications p JOIN operational_state saved
        ON saved.key='publication_input:'||p.id::text
        CROSS JOIN LATERAL jsonb_array_elements(CASE
          WHEN jsonb_typeof(saved.value->'inputs')='array' THEN saved.value->'inputs' ELSE '[]'::jsonb END) input
        WHERE p.story_id=s.id AND p.message_id IS NOT NULL
          AND (p.status='published' OR p.published_at IS NOT NULL)
          AND saved.value->>'version'='publication-input-v2'
          AND input->>'itemId'=i.id::text AND input->>'contentHash'=r.content_hash
          AND input->'payload'->>'kind' IN ('text','image')));

-- Retain compatibility tables, but no obsolete association may remain authoritative.
DELETE FROM story_link_sources;
DELETE FROM source_link_processing;
WITH retired AS (
  UPDATE stage_state SET status='skipped',next_retry_at=NULL,completed_at=now(),
    error_code=NULL,waiting_reason=NULL,outcome_unknown=false,updated_at=now()
  WHERE stage LIKE 'source_links:%' AND status IN ('pending','running','waiting','failed')
  RETURNING batch_id,revision_id
), recoverable_batches AS (
  SELECT p.id FROM processing_batches p
  WHERE p.manual_operation_id IS NULL AND (p.completed_at IS NULL OR p.error_code='partial_unit_failure')
    AND (p.error_code IS NULL OR p.error_code='partial_unit_failure')
    AND NOT EXISTS(SELECT 1 FROM batch_sources bs WHERE bs.batch_id=p.id AND bs.status='failed')
    AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.provider='telegram-user'
      AND (a.operation=p.id::text OR a.next_retry_at>now())
      AND (a.status IN ('retryable','unknown') OR a.error_code='telegram_rate_limit')
      AND a.next_retry_at IS NOT NULL)
), released AS (
  UPDATE batch_items bi SET status='pending'
  WHERE bi.status='failed' AND bi.disposition_reason IS NULL
    AND bi.batch_id IN (SELECT id FROM recoverable_batches)
    AND EXISTS(SELECT 1 FROM retired r WHERE r.batch_id=bi.batch_id AND r.revision_id=bi.revision_id)
    AND EXISTS(SELECT 1 FROM source_items i WHERE i.current_revision_id=bi.revision_id)
    AND NOT EXISTS(SELECT 1 FROM stage_state st WHERE st.batch_id=bi.batch_id AND st.revision_id=bi.revision_id
      AND st.stage NOT LIKE 'source_links:%' AND st.status IN ('pending','running','waiting','failed'))
  RETURNING batch_id,revision_id
)
UPDATE processing_batches p SET status='queued',completed_at=NULL,next_retry_at=NULL,
  error_code=NULL,waiting_reason=NULL
WHERE (EXISTS(SELECT 1 FROM retired r WHERE r.batch_id=p.id) OR EXISTS(SELECT 1 FROM released r WHERE r.batch_id=p.id))
  AND p.id IN (SELECT id FROM recoverable_batches)
  AND NOT EXISTS(SELECT 1 FROM batch_items bi WHERE bi.batch_id=p.id AND bi.status='failed'
    AND NOT EXISTS(SELECT 1 FROM released r WHERE r.batch_id=bi.batch_id AND r.revision_id=bi.revision_id))
  AND NOT EXISTS(SELECT 1 FROM stage_state st WHERE st.batch_id=p.id AND st.stage NOT LIKE 'source_links:%'
    AND st.status IN ('pending','running','waiting','failed'));

-- Publication snapshots, input receipts, delivery attempts and reservations are immutable here.
-- In particular, never reset an unknown Telegram outcome into sendable work.
