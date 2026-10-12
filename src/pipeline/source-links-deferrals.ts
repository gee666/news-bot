import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { evidenceLinkSql } from '../sources/link-policy.js';
import { eventSemanticHash, type EventInput } from './consolidation-input.js';
import { hash, retryDecision } from './state.js';

export const sourceLinksFingerprintSql = `(SELECT md5(coalesce(string_agg(
  length(l.url)::text||':'||l.url||length(coalesce(l.anchor_text,''))::text||':'||coalesce(l.anchor_text,''),
  '' ORDER BY l.url,coalesce(l.anchor_text,'')),'')) FROM item_links l WHERE l.revision_id=r.id AND ${evidenceLinkSql})`;
const scopeSchema = z.object({ revisionId: z.uuid(), itemId: z.uuid(), textHash: z.string(), linksHash: z.string() });
export type SourceSelectionScope = z.infer<typeof scopeSchema>;
const deferralSchema = z.object({ status: z.enum(['unresolved','resolved']), attempts: z.number().int().nonnegative(),
  next: z.string().nullable().optional() });
export type SourceSelection = { key: string; scope: SourceSelectionScope; storyId: string | null; storyHash: string | null;
  linkId: string | null; linkHash: string | null; inputHash: string };
export async function sourceSelectionScope(revisionId: string): Promise<SourceSelectionScope> {
  const result = await db.query(`SELECT r.id AS "revisionId",r.item_id AS "itemId",
    encode(sha256(convert_to(r.original_text,'UTF8')),'hex') AS "textHash",${sourceLinksFingerprintSql} AS "linksHash"
    FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id WHERE r.id=$1`, [revisionId]);
  return scopeSchema.parse(result.rows[0]);
}
export function sourceSelection(scope: SourceSelectionScope, input: unknown, story?: EventInput,
  link?: { id: string; url: string; anchor_text: string | null }): SourceSelection {
  const inputHash = hash(input);
  return { key: `source_link_deferred:${hash(story && link ? { item: scope.itemId,text: scope.textHash,
    link: [link.url,link.anchor_text ?? ''],story: eventSemanticHash(story) } : { item: scope.itemId,inputHash,storyId: story?.id ?? null })}`,
    scope, inputHash, storyId: story?.id ?? null, storyHash: story ? eventSemanticHash(story) : null,
    linkId: link?.id ?? null, linkHash: link ? hash([link.url,link.anchor_text ?? '']) : null };
}
export async function sourceSelectionDeferred(selection: SourceSelection, settings: AppSettings): Promise<boolean> {
  const row = (await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [selection.key])).rows[0];
  if (!row) return false;
  const saved = deferralSchema.parse(row.value);
  return saved.status==='unresolved' && (saved.attempts>=settings.requestMaxAttempts
    || !saved.next || Date.parse(saved.next)>Date.now());
}
export async function deferSourceSelection(selection: SourceSelection, phase: 'role'|'relevance'|'confirmation', error: unknown,
  settings: AppSettings): Promise<void> {
  const previous = (await db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [selection.key])).rows[0];
  const attempts = (previous ? deferralSchema.parse(previous.value).attempts : 0)+1;
  const decision = retryDecision(error, attempts, settings);
  await db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2) ON CONFLICT(key)
    DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, [selection.key, JSON.stringify({ ...selection, phase,
      status: 'unresolved', attempts, next: decision.next?.toISOString() ?? null, errorCode: decision.code })]);
}
export async function resolveSourceSelection(key: string): Promise<void> {
  await db.query(`UPDATE operational_state SET value=value||'{"status":"resolved","next":null}'::jsonb,updated_at=now() WHERE key=$1`, [key]);
}
