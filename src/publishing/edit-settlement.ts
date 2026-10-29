import type { PoolClient } from 'pg';

/** Keep every retired desired snapshot so staging cannot buy a fresh budget for unchanged content. */
export async function settleEdit(client: Pick<PoolClient, 'query'>, publicationId: string, snapshotId: string,
  code: string): Promise<void> {
  await client.query(`INSERT INTO operational_state(key,value)
    VALUES($1,jsonb_build_object('snapshotId',$2::text,'status','failed','errorCode',$3::text))
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
  [`publication_edit_settled:${publicationId}:${snapshotId}`,snapshotId,code]);
  await client.query(`UPDATE request_attempts SET status='failed',finished_at=now(),
    response_metadata=response_metadata||jsonb_build_object('terminalUnknown',status IN ('running','unknown'),'previousErrorCode',error_code),
    error_code=CASE WHEN error_code='telegram_rate_limit' AND next_retry_at>now() THEN error_code ELSE $3 END,
    next_retry_at=CASE WHEN error_code='telegram_rate_limit' AND next_retry_at>now() THEN next_retry_at ELSE NULL END
    WHERE publication_id=$1 AND operation='edit' AND status IN ('running','unknown','retryable')
      AND coalesce(response_metadata->>'snapshotId',$2)=$2`,[publicationId,snapshotId,code]);
  await client.query(`UPDATE publications SET pending_snapshot_id=NULL,error_code=$3,updated_at=now()
    WHERE id=$1 AND pending_snapshot_id=$2`,[publicationId,snapshotId,code]);
}
