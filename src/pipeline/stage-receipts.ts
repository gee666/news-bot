/** Use with stage_state alias s. Validation is terminal only after metered completion,
 * not merely because an unknown request was labeled invalid_output. Historical flags stay intact. */
export const completedOutputReceiptSql = `(
  s.started_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM model_usage_calls u WHERE (u.operation_id=s.id::text OR u.operation_id LIKE s.id::text||':%')
    AND u.timestamp>=s.started_at AND u.outcome='completed' AND u.usage_known)
  AND NOT EXISTS(SELECT 1 FROM model_usage_calls u WHERE (u.operation_id=s.id::text OR u.operation_id LIKE s.id::text||':%')
    AND u.timestamp>=s.started_at AND (u.outcome<>'completed' OR NOT u.usage_known))
  AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE (a.operation=s.id::text OR a.operation LIKE s.id::text||':%')
    AND a.dispatched_at>=s.started_at AND (a.status='running' OR
      (a.status='unknown' AND a.error_code IS DISTINCT FROM 'invalid_output')))
)`;
