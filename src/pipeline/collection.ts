import { db } from '../db.js';
import { collectPrimarySources } from '../sources/collector.js';
import { collectTelegramBatch } from '../telegram/batch.js';
import type { AppSettings } from '../settings.js';
import { FailedStageError, Waiting } from './state.js';

export function collectionFailure(error: unknown, attempt: number, settings: AppSettings): { next: Date | null; code: string; unknown: boolean; cooldown:Date | null } {
  const message = error instanceof Error ? error.message : '';
  const flood = /FLOOD_WAIT[_ ](\d+)/u.exec(message);
  const transient = /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|TIMEOUT|timed out|connection.*closed/iu.test(message);
  const unknown = /TIMEOUT|timed out/iu.test(message);
  const delay = Math.max(unknown ? 300_000 : 0,
    Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.min(attempt - 1, 12)));
  return { next: flood && attempt < settings.requestMaxAttempts ? new Date(Date.now() + Math.max(delay, Number(flood[1]) * 1000))
    : transient && attempt < settings.requestMaxAttempts ? new Date(Date.now() + delay) : null,
  cooldown: flood ? new Date(Date.now()+Number(flood[1])*1000) : null,
  code: flood ? 'telegram_rate_limit' : transient ? 'telegram_connection_failed' : 'telegram_collection_failed', unknown };
}

export async function telegramCollectionCooldown(batchId: string): Promise<Date | null> {
  const cooldown = (await db.query<{ next: Date | null }>(`SELECT max(next_retry_at) AS next FROM request_attempts
    WHERE provider='telegram-user' AND next_retry_at>now()`)).rows[0]?.next;
  if (cooldown) {
    await db.query(`UPDATE processing_batches SET status=CASE WHEN status='queued' THEN 'queued' ELSE 'waiting' END,next_retry_at=$2,error_code='telegram_collection_cooldown',
      waiting_reason='Telegram collection is cooling down.' WHERE id=$1`, [batchId, cooldown]);
  }
  return cooldown ?? null;
}

export async function collectBatch(batchId: string, cutoff: Date, settings: AppSettings): Promise<void> {
  // Publisher collection is independent of Telegram session availability.
  const previous = await db.query<{ primary_collection_completed_at: Date | null }>(
    'SELECT primary_collection_completed_at FROM processing_batches WHERE id=$1', [batchId]);
  if (!previous.rows[0]?.primary_collection_completed_at) {
    const primary = await collectPrimarySources(batchId, cutoff, settings);
    await db.query(`UPDATE processing_batches SET primary_collection_completed_at=now(),
      error_code=CASE WHEN $2::int>0 THEN 'partial_source_failure' ELSE error_code END,
      waiting_reason=CASE WHEN $2::int>0 THEN $3 ELSE waiting_reason END WHERE id=$1`, [batchId, primary.failed,
    `${primary.failed} primary source(s) failed collection. Collected items can finish; failed sources retry on the next intake, not by replaying completed processing.`]);
  }
  const history = await db.query<{ attempt: number; completed: boolean }>(`SELECT COALESCE(MAX(attempt_number),0)+1 AS attempt,
    coalesce(bool_or(status='succeeded'),false) AS completed
    FROM request_attempts WHERE provider='telegram-user' AND operation=$1`, [batchId]);
  // Collection membership is frozen. Processing checkpoints reuse its completed receipt.
  if (history.rows[0]?.completed) return;
  if (await telegramCollectionCooldown(batchId)) throw new Waiting('Telegram collection is cooling down.');
  const attempt = history.rows[0]?.attempt ?? 1;
  if (attempt>settings.requestMaxAttempts) {
    await db.query("UPDATE processing_batches SET status='failed',next_retry_at=NULL,error_code='telegram_collection_retry_exhausted' WHERE id=$1",[batchId]);
    throw new FailedStageError('telegram_collection_retry_exhausted');
  }
  const dispatched = await db.query<{ id: string }>(`INSERT INTO request_attempts(provider,operation,attempt_number,status)
    VALUES('telegram-user',$1,$2,'running') RETURNING id`, [batchId, attempt]);
  const id = dispatched.rows[0]?.id;
  try {
    await collectTelegramBatch(batchId, cutoff, settings.collectionWindowHours);
    await db.query("UPDATE request_attempts SET status='succeeded',finished_at=now() WHERE id=$1", [id]);
  } catch (error) {
    const failure = collectionFailure(error, attempt, settings);
    await db.query(`UPDATE request_attempts SET status=$2,finished_at=now(),next_retry_at=$3,error_code=$4 WHERE id=$1`,
      [id, failure.unknown ? 'unknown' : failure.next ? 'retryable' : 'failed', failure.next ?? failure.cooldown, failure.code]);
    await db.query(`UPDATE processing_batches SET status=CASE WHEN status='queued' AND $3::timestamptz IS NOT NULL THEN 'queued' ELSE $2 END,next_retry_at=$3,error_code=$4,
      waiting_reason='Telegram collection could not finish. Check account access and connectivity.' WHERE id=$1`,
    [batchId, failure.next ? 'waiting' : 'failed', failure.next, failure.code]);
    throw error;
  }
}
