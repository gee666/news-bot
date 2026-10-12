import { z } from 'zod';
import type { PoolClient } from 'pg';
import { primaryCursorSchema, type PrimaryCursor } from './config.js';

function recoverCursor(input: unknown, collectedIds: ReadonlySet<string>): PrimaryCursor {
  const cursor = primaryCursorSchema.parse(input);
  const skipped = new Set(cursor.skippedUnknownIds.filter(id => !collectedIds.has(id)));
  if (cursor.unknownPolicy === null) for (const id of cursor.unknownIds) {
    if (!collectedIds.has(id)) skipped.add(id);
  }
  return { ...cursor, unknownPolicy: 'collect_once', skippedUnknownIds: [],
    unknownIds: [...new Set([...cursor.unknownIds.filter(id => !skipped.has(id)),
      ...cursor.skippedUnknownIds.filter(id => collectedIds.has(id))])].slice(-1000),
    completedIds: cursor.completedIds.filter(id => !skipped.has(id)),
    seen: cursor.seen.filter(item => !skipped.has(item.id)) };
}

/** Policy changes recover skipped IDs, not already ingested undated articles. No item history is reset. */
export async function recoverSkippedPublication(client: Pick<PoolClient, 'query'>, sourceId: string,
  input: unknown): Promise<PrimaryCursor> {
  const sourceCursor = primaryCursorSchema.parse(input);
  const batches = await client.query(`SELECT batch_id,COALESCE(cursor_after,cursor_before) AS cursor
    FROM batch_sources WHERE source_id=$1 AND status <> 'completed' ORDER BY batch_id FOR UPDATE`, [sourceId]);
  const parsedBatches = batches.rows.map((row: unknown) => z.object({ batch_id: z.uuid(), cursor: primaryCursorSchema }).parse(row));
  const candidates = [...new Set([sourceCursor, ...parsedBatches.map(batch => batch.cursor)]
    .flatMap(cursor => [...cursor.unknownIds, ...cursor.skippedUnknownIds]))];
  const saved = await client.query('SELECT external_id FROM source_items WHERE source_id=$1 AND external_id=ANY($2::text[])', [sourceId, candidates]);
  const collectedIds = new Set(saved.rows.map((row: unknown) => z.object({ external_id: z.string() }).parse(row).external_id));
  for (const batch of parsedBatches) {
    await client.query('UPDATE batch_sources SET cursor_after=$3::jsonb WHERE batch_id=$1 AND source_id=$2',
      [batch.batch_id, sourceId, JSON.stringify(recoverCursor(batch.cursor, collectedIds))]);
  }
  return recoverCursor(sourceCursor, collectedIds);
}
