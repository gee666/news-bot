import { z } from 'zod';
import { db } from '../db.js';
import { getSettings, settingsSchema } from '../settings.js';
import { collectBatch } from './collection.js';
import { Waiting } from './state.js';
import { recordProcessingDiagnostic } from './processing-diagnostics.js';

const snapshot = z.object({ id: z.uuid(), cutoff_at: z.date(), settings_snapshot: settingsSchema });

/** Persist the due slot before trying a busy processor, without doing any source I/O. */
export async function requestScheduledIntake(slot: Date): Promise<void> {
  if (!Number.isFinite(slot.getTime())) throw new Error('Invalid collection slot');
  await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [`scheduled_intake:${slot.toISOString()}`, JSON.stringify({ slot: slot.toISOString() })]);
}

/** Caller holds the processor lease. One due snapshot per checkpoint keeps collection bounded. */
export async function drainScheduledIntake(): Promise<void> {
  const requested = await db.query<{ key: string; value: unknown }>(`SELECT key,value FROM operational_state
    WHERE key LIKE 'scheduled_intake:%' ORDER BY key LIMIT 1`);
  const row = requested.rows[0]; if (!row) return;
  const data = z.object({ slot: z.iso.datetime() }).parse(row.value);
  await collectScheduledIntake(new Date(data.slot));
  await db.query('DELETE FROM operational_state WHERE key=$1', [row.key]);
}

/** Caller holds the processor lease. Collection does not submit model work. */
export async function collectScheduledIntake(slot: Date): Promise<void> {
  if (!Number.isFinite(slot.getTime())) throw new Error('Invalid collection slot');
  const settings = await getSettings();
  const inserted = await db.query(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,scheduled_slot)
    VALUES('queued',$1,$2,$3,$4,$1) ON CONFLICT(scheduled_slot) DO NOTHING RETURNING *`,
  [slot, JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
  if (!inserted.rows.length) return; // A second scheduler instance cannot repeat the same snapshot.
  const batch = snapshot.parse(inserted.rows[0]);
  try {
    await collectBatch(batch.id, batch.cutoff_at, batch.settings_snapshot);
    await db.query(`UPDATE processing_batches SET
      waiting_reason=CASE WHEN error_code='partial_source_failure' THEN waiting_reason ELSE 'Collected snapshot is queued for processing.' END,
      next_retry_at=NULL,error_code=CASE WHEN error_code='partial_source_failure' THEN error_code ELSE NULL END
      WHERE id=$1 AND status='queued'`, [batch.id]);
  } catch (error) {
    // Source progress and membership are already atomic. Keep partial intake queued for
    // its saved connector retry; never mark unprocessed items completed to free admission.
    if (!(error instanceof Waiting)) await recordProcessingDiagnostic(error, { scope: 'batch', batchId: batch.id });
    await db.query(`UPDATE processing_batches SET status=CASE WHEN status='queued' AND next_retry_at IS NULL THEN 'failed' ELSE status END,
      waiting_reason=coalesce(waiting_reason,'Source collection needs correction before processing.'),
      error_code=coalesce(error_code,'collection_failed') WHERE id=$1`, [batch.id]);
  }
}
