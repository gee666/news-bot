import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { jevTemplates } from '../models/templates.js';
import { eventDecisionInput, eventSemanticHash, type EventInput } from './consolidation-input.js';
import { hash } from './state.js';
const relationSchema = z.enum(['same','update','different']);
export type ConsolidationRelation = z.infer<typeof relationSchema>;
const key = (left: EventInput,right: EventInput) => `consolidation_decision:${eventSemanticHash(left,right)}`;
/** A held pair pins intake, but must not buy another inference for every already
 * decided neighbor when caches expire or deployment settings change. */
export async function consolidationDecision(left: EventInput,right: EventInput): Promise<ConsolidationRelation | undefined> {
  const row = (await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1',[key(left,right)])).rows[0];
  return row ? z.object({ relation: relationSchema }).parse(row.value).relation : undefined;
}
export async function saveConsolidationDecision(left: EventInput,right: EventInput,relation: ConsolidationRelation,settings: AppSettings): Promise<void> {
  await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key) DO NOTHING`,[key(left,right),JSON.stringify({
    leftId: left.id,rightId: right.id,inputHash: hash(eventDecisionInput(left,right)),relation,
    modelVersion: settings.modelVersion,promptVersion: jevTemplates.duplicate.version,
  })]);
}
