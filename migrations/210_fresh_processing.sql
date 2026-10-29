-- Connector cooldowns belong to request receipts, not to already collected input.
UPDATE processing_batches b SET status='queued',completed_at=NULL,next_retry_at=NULL,
  waiting_reason='Collected inputs can process independently of connector recovery.'
WHERE b.manual_operation_id IS NULL AND b.error_code IN ('telegram_collection_cooldown','telegram_rate_limit',
  'telegram_connection_failed','telegram_collection_failed','telegram_collection_retry_exhausted')
  AND EXISTS(SELECT 1 FROM batch_items i WHERE i.batch_id=b.id AND i.status IN ('pending','processing'));
