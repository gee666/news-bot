import { z } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { collectPublisher, publisherReader } from '../sources/collector.js';
import { PostgresSourceCollectionStore } from '../sources/collection-store.js';
import { parsePrimarySource } from '../sources/repository.js';
import { withUserClient } from '../telegram/client.js';
import { collectSource } from '../telegram/collector.js';
import { TelegramHistory } from '../telegram/history.js';
import { parseSource } from '../telegram/repository.js';
import type { RunNowOptions } from './run-now-contract.js';
import { collectionFailure, telegramCollectionCooldown } from './collection.js';
import { Waiting } from './state.js';

const sourceRow = z.object({ id: z.uuid(), connector_type: z.enum(['telegram', 'feed', 'website']), status: z.string() });

/** Pin source selection before I/O. Cursor changes and membership use the normal atomic store. */
export async function collectRunNow(batchId: string, cutoff: Date, settings: AppSettings, options: RunNowOptions): Promise<void> {
  await db.query(`INSERT INTO batch_sources(batch_id,source_id,cursor_before)
    SELECT $1,id,collection_cursor FROM sources WHERE enabled AND active
      AND connector_type IN ('telegram','feed','website')
      AND NOT EXISTS(SELECT 1 FROM batch_sources WHERE batch_id=$1)
    ORDER BY updated_at,id LIMIT $2 ON CONFLICT DO NOTHING`, [batchId, Math.min(options.sourceLimit, options.inputLimit)]);
  const result = await db.query(`SELECT s.*,bs.status,COALESCE(bs.cursor_after,bs.cursor_before) AS collection_cursor
    FROM batch_sources bs JOIN sources s ON s.id=bs.source_id WHERE bs.batch_id=$1 ORDER BY s.id`, [batchId]);
  const store = new PostgresSourceCollectionStore();
  for (const [index, row] of result.rows.entries()) {
    const source = sourceRow.parse(row);
    if (source.status === 'completed' || source.status === 'failed') continue;
    const budget = Math.floor(options.inputLimit / result.rows.length) + (index < options.inputLimit % result.rows.length ? 1 : 0);
    let attempt = 1;
    try {
      if (source.connector_type === 'telegram') {
        if (await telegramCollectionCooldown(batchId)) throw new Waiting('Telegram collection is cooling down.');
        attempt = (await db.query<{ attempt: number }>(`SELECT coalesce(max(attempt_number),0)+1 AS attempt
          FROM request_attempts WHERE provider='telegram-user' AND operation=$1`, [`${batchId}:${source.id}`])).rows[0]?.attempt ?? 1;
        await withUserClient(client => collectSource(new TelegramHistory(client), store, batchId,
          parseSource(row), cutoff, settings.collectionWindowHours, budget));
      } else {
        await collectPublisher(publisherReader, store, batchId, parsePrimarySource(row), cutoff, settings.collectionWindowHours, budget);
      }
    } catch (error) {
      if (error instanceof Waiting) throw error;
      if (source.connector_type === 'telegram') {
        const failure = collectionFailure(error, attempt, settings);
        await db.query(`INSERT INTO request_attempts(provider,operation,attempt_number,status,finished_at,next_retry_at,error_code)
          VALUES('telegram-user',$1,$2,$3,now(),$4,$5)`, [`${batchId}:${source.id}`, attempt,
          failure.unknown ? 'unknown' : failure.next ? 'retryable' : 'failed', failure.next, failure.code]);
        if (failure.next) {
          await db.query(`UPDATE processing_batches SET status='waiting',next_retry_at=$2,error_code=$3 WHERE id=$1`, [batchId, failure.next, failure.code]);
          throw new Waiting('Telegram collection is waiting for its saved retry time.');
        }
      }
      // Do not silently fan out or repeat a failed connector in this small run.
      // Uncommitted entries and their cursors remain available to normal collection.
      await db.query(`UPDATE batch_sources SET status='failed',error_code='manual_source_failed'
        WHERE batch_id=$1 AND source_id=$2 AND status<>'completed'`, [batchId, source.id]);
    }
  }
}

/** Only fresh, never-dispatched pending revisions. No failed inputs or saved waits are reset. */
export async function useCollectedInputs(batchId: string, settings: AppSettings, limit: number): Promise<void> {
  await transaction(async client => {
    const selected = await client.query<{ revision_id: string }>(`INSERT INTO batch_items(batch_id,revision_id)
      SELECT $1::uuid,r.id FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
      WHERE NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||$1::uuid::text AND o.value->>'inputSelectionDone'='true')
        AND i.retention_at>=now()-$2*interval '1 hour'
        AND NOT (r.metadata @> '{"pipelineFailure":true}'::jsonb)
        AND EXISTS(SELECT 1 FROM batch_items bi WHERE bi.revision_id=r.id AND bi.status='pending')
        AND NOT EXISTS(SELECT 1 FROM batch_items bi WHERE bi.revision_id=r.id AND bi.status<>'pending')
        AND NOT EXISTS(SELECT 1 FROM stage_state st WHERE st.revision_id=r.id)
        AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
        AND NOT EXISTS(SELECT 1 FROM batch_items bi JOIN processing_batches b ON b.id=bi.batch_id
          WHERE bi.revision_id=r.id AND b.status='failed')
      ORDER BY i.retention_at DESC,r.id LIMIT $3 ON CONFLICT DO NOTHING RETURNING revision_id`, [batchId, settings.collectionWindowHours, limit]);
    // Move only never-dispatched membership. Retain the source batches and cursors,
    // and keep an audit of the original membership with the manual run.
    const moved = await client.query<{ batch_id: string; revision_id: string }>(`DELETE FROM batch_items
      WHERE batch_id<>$1 AND revision_id=ANY($2::uuid[]) AND status='pending' RETURNING batch_id,revision_id`,
    [batchId, selected.rows.map(row => row.revision_id)]);
    await client.query(`UPDATE operational_state SET value=value||$2::jsonb,updated_at=now() WHERE key=$1
        AND coalesce(value->>'inputSelectionDone','false')<>'true'`,
      [`run_now_batch:${batchId}`, JSON.stringify({ inputSelectionDone: true, transferredInputs: moved.rows })]);
  });
}
