import { z } from 'zod';
import { db } from '../db.js';
import { collectBatch } from './collection.js';
import { getActiveEmbeddingConfig, getSettings, settingsSchema } from '../settings.js';
import { extractBatch } from './extraction.js';
import { Judgments } from './judgments.js';
import { matchBatch } from './matching.js';
import { finishBatchStories } from './stories.js';
import { Vectors } from './vectors.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';
import { retryDecision, Waiting } from './state.js';
import { reconcileEdits } from './revisions.js';
import { consolidateStories } from './consolidation.js';
import { completeBatchItems, expireUnassignedMentions } from './item-failures.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';

const batchSchema = z.object({ id: z.uuid(), cutoff_at: z.date(), settings_snapshot: settingsSchema,
  status: z.string(), completed_at: z.date().nullable(), next_retry_at: z.date().nullable() });

export function processBatch(_manual: boolean, recoverOnly = false, batchId?: string, onReady?: (id: string) => Promise<void>): Promise<void> {
  return withProcessingSlice(() => processBatchSlice(recoverOnly, batchId, onReady));
}

async function processBatchSlice(recoverOnly: boolean, batchId?: string,
  onReady?: (id: string) => Promise<void>): Promise<void> {
  if(!batchId) await expireUnassignedMentions(await getSettings());
  const selected = batchId ? await db.query('SELECT * FROM processing_batches WHERE id=$1', [batchId])
    : await db.query(`SELECT * FROM processing_batches b WHERE completed_at IS NULL
      AND (next_retry_at IS NULL OR next_retry_at<=now())
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='run_now_batch:'||b.id::text)
      ORDER BY EXISTS(SELECT 1 FROM batch_items bi JOIN story_mentions m ON m.revision_id=bi.revision_id
        JOIN source_items i ON i.current_revision_id=m.revision_id WHERE bi.batch_id=b.id AND bi.status<>'rejected'
          AND m.story_id IS NULL AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window') DESC,
        EXISTS(SELECT 1 FROM batch_items i WHERE i.batch_id=b.id
          AND i.status IN ('pending','processing')) DESC,cutoff_at DESC,started_at DESC,b.id LIMIT 1`);
  let batch = selected.rows.length ? batchSchema.parse(selected.rows[0]) : undefined;
  if (batch && (batch.completed_at || (batch.next_retry_at && batch.next_retry_at>new Date()))) return;
  if (!batch) {
    if (recoverOnly || batchId) return;
    const settings = await getSettings();
    batch = batchSchema.parse((await db.query(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES('collecting',now(),$1,$2,$3) RETURNING *`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion])).rows[0]);
  }
  const settings = batch.settings_snapshot;
  // Processing is read-only remotely. Interrupted requests can retry after cooldown without approvals.
  await db.query(`UPDATE stage_state SET status='waiting',outcome_unknown=true,
    next_retry_at=now()+interval '5 minutes',error_code='interrupted_request',updated_at=now()
    WHERE batch_id=$1 AND status='running'`, [batch.id]);
  try {
    await db.query("UPDATE processing_batches SET status='collecting',error_code=NULL,waiting_reason=NULL,next_retry_at=NULL WHERE id=$1", [batch.id]);
    const replay = await db.query('SELECT 1 FROM operational_state WHERE key=$1', [`reprocess_batch:${batch.id}`]);
    if (!batchId && !replay.rows.length) await collectBatch(batch.id, batch.cutoff_at, settings);
    await db.query("UPDATE processing_batches SET status='processing' WHERE id=$1", [batch.id]);
    const judgments = new Judgments(settings);
    const vectors = new Vectors(await getActiveEmbeddingConfig(), settings);
    try {
      const processingBatchId = batch.id;
      // Saved extraction must reach matching even while another revision waits on links.
      await matchBatch(batch.id, settings, vectors);
      await extractBatch(batch.id, settings, async revisionId => {
        const mentions = await db.query<{ id: string }>('SELECT id FROM story_mentions WHERE revision_id=$1', [revisionId]);
        await matchBatch(processingBatchId, settings, vectors, mentions.rows.map(mention => mention.id));
        await reconcileEdits(processingBatchId, settings, [revisionId]);
        await completeBatchItems(processingBatchId, undefined, revisionId);
        if (!batchId) {
          const stories = await db.query<{ story_id: string }>('SELECT DISTINCT story_id FROM story_mentions WHERE revision_id=$1 AND story_id IS NOT NULL', [revisionId]);
          await finishBatchStories(processingBatchId, settings, judgments, vectors, onReady, stories.rows.map(story => story.story_id));
        }
      });
      await matchBatch(batch.id, settings, vectors);
      await reconcileEdits(batch.id, settings);
      await consolidateStories(settings, batch.id);
      await finishBatchStories(batch.id, settings, judgments, vectors, onReady);
      await completeBatchItems(batch.id);
    } finally { await Promise.all([judgments.close(), vectors.close()]); }
  } catch (error) {
    if (error instanceof ProcessingYield) {
      await db.query(`UPDATE processing_batches SET status='waiting',next_retry_at=now()+interval '1 second',
        error_code=NULL,waiting_reason='Processing checkpoint reached.' WHERE id=$1`, [batch.id]);
      return;
    }
    if (error instanceof Waiting) {
      const saved = await db.query<{ next_retry_at: Date | null }>('SELECT next_retry_at FROM processing_batches WHERE id=$1', [batch.id]);
      if (saved.rows[0]?.next_retry_at && saved.rows[0].next_retry_at>new Date()) return;
    } else await recordProcessingDiagnostic(error, { scope: 'batch', batchId: batch.id });
    // Infrastructure failures do not claim any item and cannot take priority over later intake.
    const decision = retryDecision(error, 1, settings);
    await db.query(`UPDATE processing_batches SET status='waiting',next_retry_at=$2,error_code=$3,waiting_reason=$4 WHERE id=$1`,
      [batch.id, decision.next ?? new Date(Date.now()+settings.retryMaxMs), decision.code, decision.reason]);
    throw error;
  }
}
