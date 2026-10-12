import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { eventDecisionInput, eventSemanticHash, type EventInput } from './consolidation-input.js';
import type { ConsolidationIntake } from './consolidation-intake.js';
import { hash, retryDecision, type StageContext } from './state.js';

const deferredSchema = z.object({ leftId: z.uuid(), rightId: z.uuid(), inputHash: z.string(),
  status: z.enum(['unresolved','resolved']), attempts: z.number().int().nonnegative(), next: z.string().nullable().optional() });
export type DeferredConsolidation = z.infer<typeof deferredSchema>;
export function consolidationPairKey(left: EventInput, right: EventInput): string {
  return `consolidation_deferred:${eventSemanticHash(left,right)}`;
}
export async function consolidationDeferral(key: string): Promise<DeferredConsolidation | undefined> {
  const row = (await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [key])).rows[0];
  return row ? deferredSchema.parse(row.value) : undefined;
}
export async function deferConsolidationPair(key: string, left: EventInput, right: EventInput, settings: AppSettings,
  intake: readonly ConsolidationIntake[], context: StageContext, error: unknown): Promise<void> {
  const attempts = ((await consolidationDeferral(key))?.attempts ?? 0)+1;
  const decision = retryDecision(error, attempts, settings);
  await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key)
    DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [key, JSON.stringify({ leftId: left.id, rightId: right.id,
      inputHash: hash(eventDecisionInput(left,right)), intake, originBatchId: context.batchId,
      status: decision.next ? 'unresolved' : 'resolved', attempts, next: decision.next?.toISOString() ?? null,
      errorCode: decision.code })]);
}
export async function resolveConsolidationPair(key: string): Promise<void> {
  await db.query(`UPDATE operational_state SET value=value||'{"status":"resolved","next":null}'::jsonb,updated_at=now() WHERE key=$1`, [key]);
}
