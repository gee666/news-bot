import { z } from 'zod';
import { db } from '../db.js';
import type { Operation, OperationOutcome } from './operations.js';
import { partialCompletionLabel } from './status-labels.js';

const timestamp = z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.iso.datetime());
const batchSchema = z.object({ id: z.uuid(), status: z.enum(['queued', 'collecting', 'processing', 'waiting', 'completed', 'failed']),
  next_retry_at: timestamp.nullable(), error_code: z.string().nullable(), failed_items: z.number().int().nonnegative() });

function outcome(batch: z.infer<typeof batchSchema>): OperationOutcome {
  if (batch.status === 'completed' && batch.error_code === 'partial_story_failure') {
    return { status: 'completed_with_errors', message: 'Collection completed with withheld stories. See processing status for counts and correction.' };
  }
  if (batch.status === 'completed' && batch.error_code === 'partial_item_failure') {
    return { status: 'completed_with_errors', message: `${partialCompletionLabel(batch.failed_items)}. Withheld items need explicit correction.` };
  }
  if (batch.status === 'completed') return { status: 'succeeded', message: 'Collection batch completed.' };
  if (batch.status === 'failed') return { status: 'failed', message: 'Collection batch failed. See processing status for the stage and failure reason.' };
  if (batch.status === 'queued') return { status: 'waiting', nextRetryAt: batch.next_retry_at,
    message: 'Collected source snapshot is queued. Model processing is paused or earlier work owns the processor.' };
  if (batch.status === 'waiting') return { status: 'waiting', nextRetryAt: batch.next_retry_at,
    message: 'Collection batch is waiting. The pipeline will resume it at the saved retry time.' };
  return { status: 'running', message: 'Collection batch is still processing. Follow processing status for progress.' };
}

export async function observeCollection(operation: Operation): Promise<OperationOutcome | undefined> {
  if (operation.kind !== 'collection' || !operation.batchId) return;
  const result = await db.query<{ id: unknown; status: unknown; next_retry_at: unknown; error_code: unknown; failed_items: unknown }>(
    `SELECT b.id,b.status,b.next_retry_at,b.error_code,
      (SELECT count(*)::int FROM batch_items i WHERE i.batch_id=b.id AND i.status='failed') AS failed_items
      FROM processing_batches b WHERE b.id=$1`, [operation.batchId]);
  // History cleanup must not turn a previously completed operation into a failure.
  return result.rows[0] ? outcome(batchSchema.parse(result.rows[0])) : undefined;
}

export async function runCollectionOperation(operation: Operation, run: () => Promise<void>): Promise<OperationOutcome> {
  const existing = await db.query<{ id: string }>(`SELECT id FROM processing_batches
    WHERE completed_at IS NULL AND status IN ('queued','collecting','processing','waiting','failed')
    ORDER BY CASE WHEN status IN ('collecting','processing','waiting') THEN 0 WHEN status='failed' THEN 1 ELSE 2 END,started_at LIMIT 1`);
  const existingId = existing.rows[0] ? z.uuid().parse(existing.rows[0].id) : null;
  let failed = false;
  try { await run(); } catch { failed = true; }
  finally {
    // A failed batch can be replaced when settings changed. Prefer that new batch over its predecessor.
    const result = await db.query<{ id: string }>(`SELECT id FROM processing_batches
      WHERE id=$1 OR started_at >= $2 ORDER BY started_at DESC LIMIT 1`, [existingId, operation.createdAt]);
    if (result.rows[0]) operation.batchId = z.uuid().parse(result.rows[0].id);
  }
  const observed = await observeCollection(operation);
  if (failed && observed?.status !== 'waiting' && observed?.status !== 'failed') {
    return { status: 'failed', message: 'Collection request failed. See processing status for the failure reason.' };
  }
  return observed ?? { status: 'failed',
    message: 'Collection was skipped without creating a batch. The pipeline may be busy with another operation.' };
}
