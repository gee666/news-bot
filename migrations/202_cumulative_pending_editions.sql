-- Retire only definitely unsent automatic source edits. Unknown edits still reconcile
-- against their original snapshot. Source additions become new cumulative editions.
CREATE TEMP TABLE cumulative_source_edits ON COMMIT DROP AS
SELECT p.id,coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) AS story_id
FROM publications p
JOIN publication_snapshots sent ON sent.id=p.snapshot_id
JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id
LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
WHERE p.status='published' AND p.message_id IS NOT NULL
  AND NOT (desired.content ? 'updatedTo')
  AND (desired.content-'sources')=(sent.content-'sources')
  AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit'
    AND (a.status IN ('running','unknown') OR a.response_metadata ? 'approvalId'));

INSERT INTO operational_state(key,value)
SELECT DISTINCT 'digest_refresh:'||s.id::text,jsonb_build_object('storyId',s.id)
FROM cumulative_source_edits e JOIN stories s ON s.id=e.story_id
WHERE s.status NOT IN ('failed','rejected')
ON CONFLICT(key) DO NOTHING;

UPDATE request_attempts a SET status='failed',finished_at=now(),
  response_metadata=a.response_metadata||jsonb_build_object('superseded',true,'previousErrorCode',a.error_code),
  error_code=CASE WHEN a.error_code='telegram_rate_limit' AND a.next_retry_at>now() THEN a.error_code ELSE 'edit_superseded' END,
  next_retry_at=CASE WHEN a.error_code='telegram_rate_limit' AND a.next_retry_at>now() THEN a.next_retry_at ELSE NULL END
FROM cumulative_source_edits e
WHERE a.publication_id=e.id AND a.operation='edit' AND a.status='retryable';
UPDATE publications p SET pending_snapshot_id=NULL,updated_at=now()
FROM cumulative_source_edits e WHERE p.id=e.id;
