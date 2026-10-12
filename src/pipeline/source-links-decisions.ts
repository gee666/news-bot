import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { hash } from './state.js';
import { sourceLinksFingerprintSql, type SourceSelection } from './source-links-deferrals.js';
import { verdictSchema, validSourceVerdicts, type SourceVerdict, type SourceConfirmationInput } from './source-links-confirmation.js';
import { eventInput, eventSemanticHash } from './consolidation-input.js';

const role = z.enum(['source_only','excluded','other']);
const classification = z.enum(['relevant','irrelevant','uncertain']);
const metadata = z.object({ modelKey: z.string(),modelVersion: z.number().int().positive(),promptVersion: z.string() });
const roleSchema = metadata.extend({ role });
const relevanceSchema = metadata.extend({ classification });
const confirmationSchema = metadata.extend({ proof: verdictSchema });
export type RelevanceDecision = z.infer<typeof relevanceSchema>;
export type ConfirmationDecision = z.infer<typeof confirmationSchema>;
function key(selection: SourceSelection, phase: 'role'|'relevance'|'confirmation'): string {
  return `source_selection_decision:${hash({ phase,itemId: selection.scope.itemId,text: selection.scope.textHash,
    ...(phase==='role' ? { links: selection.scope.linksHash } : { link: selection.linkHash,story: selection.storyHash }) })}`;
}
async function read(selection: SourceSelection, phase: 'role'|'relevance'|'confirmation'): Promise<unknown | undefined> {
  return (await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1',[key(selection,phase)])).rows[0]?.value;
}
export async function sourceRoleDecision(selection: SourceSelection) {
  const saved = await read(selection,'role'); return saved===undefined ? undefined : roleSchema.parse(saved);
}
export async function sourceRelevanceDecision(selection: SourceSelection): Promise<RelevanceDecision | undefined> {
  const saved = await read(selection,'relevance'); return saved===undefined ? undefined : relevanceSchema.parse(saved);
}
export async function sourceConfirmationDecision(selection: SourceSelection, input: SourceConfirmationInput): Promise<ConfirmationDecision | undefined> {
  const saved = await read(selection,'confirmation');
  if (saved===undefined) return undefined;
  const parsed = confirmationSchema.parse(saved);
  const candidate = input.candidates[0];
  if (!candidate || input.candidates.length!==1) throw new Error('Confirmation receipt requires one exact candidate');
  const proof = { ...parsed.proof,candidate_id: candidate.candidate_id };
  return validSourceVerdicts(input,[proof]) ? { ...parsed,proof } : undefined;
}
/** Only fulfilled validated decisions are written. No TTL, catalogue, prompt or
 * model change can buy another request for the same owned semantic selection. */
async function save(selection: SourceSelection, phase: 'role'|'relevance'|'confirmation', value: unknown): Promise<void> {
  if (selection.storyId) {
    const current = await eventInput(selection.storyId);
    if (!current || eventSemanticHash(current)!==selection.storyHash) return;
  }
  await db.query(`INSERT INTO operational_state(key,value)
    SELECT $1,$2::jsonb FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
    WHERE r.id=$3 AND encode(sha256(convert_to(r.original_text,'UTF8')),'hex')=$4
      AND ${sourceLinksFingerprintSql}=$5
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
  [key(selection,phase),JSON.stringify(value),selection.scope.revisionId,selection.scope.textHash,selection.scope.linksHash]);
}
function binding(settings: AppSettings,promptVersion: string,confirmed = false) {
  return { modelKey: `${settings.jevUrl}/${settings.jevModel}`+(confirmed ? ` + ${settings.piProvider}/${settings.piModel}` : ''),
    modelVersion: settings.modelVersion,promptVersion };
}
export async function saveSourceRole(selection: SourceSelection, decision: z.infer<typeof role>,settings: AppSettings,promptVersion: string) {
  await save(selection,'role',roleSchema.parse({ ...binding(settings,promptVersion),role: decision }));
}
export async function saveSourceRelevance(selection: SourceSelection, decision: z.infer<typeof classification>,settings: AppSettings,promptVersion: string) {
  const value = relevanceSchema.parse({ ...binding(settings,promptVersion),classification: decision });
  await save(selection,'relevance',value); return value;
}
export async function saveSourceConfirmation(selection: SourceSelection, input: SourceConfirmationInput, proof: SourceVerdict,
  settings: AppSettings,promptVersion: string) {
  if (!validSourceVerdicts(input,[proof])) throw new Error('Cannot save unsupported source confirmation');
  const value = confirmationSchema.parse({ ...binding(settings,promptVersion,true),proof });
  await save(selection,'confirmation',value); return value;
}
