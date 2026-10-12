-- Primary collection preceded the Telegram dispatch and ordinary item stages.
-- Failed source receipts alone do not prove that the whole pass returned.
UPDATE processing_batches b SET primary_collection_completed_at=coalesce(
  (SELECT min(a.dispatched_at) FROM request_attempts a
    WHERE a.provider='telegram-user' AND a.operation=b.id::text AND a.stage_id IS NULL AND a.publication_id IS NULL),
  (SELECT min(s.started_at) FROM stage_state s WHERE s.batch_id=b.id
    AND (s.stage='count' OR s.stage LIKE 'extract:%')))
WHERE b.primary_collection_completed_at IS NULL AND b.manual_operation_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key IN(
    'reprocess_batch:'||b.id::text,'run_now_batch:'||b.id::text,'recovery_batch:'||b.id::text,'reprocess_scope:'||b.id::text))
  AND (EXISTS(SELECT 1 FROM request_attempts a WHERE a.provider='telegram-user' AND a.operation=b.id::text
      AND a.stage_id IS NULL AND a.publication_id IS NULL)
    OR EXISTS(SELECT 1 FROM stage_state s WHERE s.batch_id=b.id AND s.started_at IS NOT NULL
      AND (s.stage='count' OR s.stage LIKE 'extract:%')));
