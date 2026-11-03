import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Nodes } from 'mdast';
import { db } from '../db.js';
import { evidenceLinkSql } from '../sources/links.js';
import { markdownTree } from '../sources/markdown.js';

const reportSchema = z.object({
  item_id: z.uuid(), content_hash: z.string(), text: z.string(),
  source_time: z.coerce.date(), revision_time: z.coerce.date().optional(), urls: z.array(z.url()),
  collected_text: z.string().optional(), collected_urls: z.array(z.url()).optional(),
});
const payloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), tokens: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('url'), url: z.url({ protocol: /^https?$/u }) }).strict(),
]);
export const publicationBoundarySchema = z.object({ version: z.literal('publication-input-v2'),
  inputs: z.array(z.object({ itemId: z.uuid(), contentHash: z.string(), payload: payloadSchema,
    sourceTime: z.iso.datetime(), revisionTime: z.iso.datetime().optional(),
    collectedTokens: z.array(z.string().min(1)), collectedUrls: z.array(z.url()),
    collectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()),
}).strict();
export type PublicationBoundary = z.infer<typeof publicationBoundarySchema>;

function visibleText(node: Nodes): string {
  if (node.type === 'break') return ' ';
  if (node.type === 'html') return node.value.replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|pre|blockquote|table|tr|td|th)\b[^>]*>/giu, ' ')
    .replace(/<[^>]*>/gu, '').replace(/&(?:nbsp|#160|#xa0);/giu, ' ');
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';
  if ('value' in node) return node.value;
  if (!('children' in node)) return '';
  const inline = ['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'linkReference'].includes(node.type);
  return node.children.map(visibleText).join(inline ? '' : ' ');
}

/** Keep words and numbers, not Markdown syntax, casing or punctuation. Decimal separators remain
 * significant: a replacement of 1.5 with 15 must not disappear during normalization. */
export function publicationTextTokens(text: string): string[] {
  const plain = visibleText(markdownTree(text)).normalize('NFKC').toLowerCase()
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/gu, ' ');
  return plain.match(/[\p{L}\p{N}]+(?:[.,]\p{N}+)*/gu) ?? [];
}

/** Persist the scoped payload itself so removals can be distinguished from additions later. */
export function reportBoundary(rows: unknown[]): PublicationBoundary {
  const inputs: PublicationBoundary['inputs'] = [];
  const seen = new Set<string>();
  for (const row of z.array(reportSchema).parse(rows)) {
    const tokens = publicationTextTokens(row.text);
    const collectedText = row.collected_text ?? row.text;
    const collectedUrls = [...new Set(row.collected_urls ?? row.urls)].sort();
    const collectedFingerprint = createHash('sha256').update(JSON.stringify({
      text: collectedText.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(), urls: collectedUrls,
    })).digest('hex');
    const payloads: Array<z.infer<typeof payloadSchema>> = [
      ...(tokens.length ? [{ kind: 'text' as const, tokens }] : []),
      ...row.urls.map(url => ({ kind: 'url' as const, url })),
    ];
    for (const payload of payloads) {
      const key = JSON.stringify([row.item_id, payload]);
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push({ itemId: row.item_id, contentHash: row.content_hash, sourceTime: row.source_time.toISOString(),
        ...(row.revision_time ? { revisionTime: row.revision_time.toISOString() } : {}), payload,
        collectedTokens: publicationTextTokens(collectedText), collectedUrls, collectedFingerprint });
    }
  }
  return { version: 'publication-input-v2', inputs };
}

/** Retention is immutable; a refetch must not make an undated report recent again. */
const sourceInputTime = 'coalesce(i.published_at,least(i.collected_at,i.retention_at))';

export async function publicationInputBoundary(storyId: string, query = db.query.bind(db)): Promise<PublicationBoundary> {
  const rows = await query(`WITH scoped AS (
    SELECT m.revision_id,m.text,
      coalesce((SELECT jsonb_agg(DISTINCT l.url ORDER BY l.url) FROM mention_links ml
        JOIN item_links l ON l.id=ml.link_id WHERE ml.mention_id=m.id
          AND ml.classification='relevant' AND ${evidenceLinkSql}),'[]'::jsonb) AS urls
      FROM story_mentions m WHERE m.story_id=$1 AND length(trim(m.text))>0
    UNION ALL SELECT l.revision_id,'' AS text,jsonb_build_array(l.url) AS urls
      FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
      WHERE sl.story_id=$1 AND sl.classification='relevant' AND ${evidenceLinkSql}
  ) SELECT i.id AS item_id,r.content_hash,scoped.text,scoped.urls,r.normalized_text AS collected_text,
    coalesce((SELECT jsonb_agg(DISTINCT l.url ORDER BY l.url) FROM item_links l
      WHERE l.revision_id=r.id),'[]'::jsonb) AS collected_urls,
    ${sourceInputTime} AS source_time,r.created_at AS revision_time
    FROM scoped JOIN item_revisions r ON r.id=scoped.revision_id JOIN source_items i ON i.current_revision_id=r.id
    WHERE length(trim(r.normalized_text))>0 AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    ORDER BY i.id,scoped.text,scoped.urls::text`, [storyId]);
  return reportBoundary(rows.rows);
}

function tokenCounts(sequences: string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const tokens of sequences) {
    const key = JSON.stringify(tokens);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
function addedTokens(current: string[][], baseline: string[][]): Set<string> {
  const previous = tokenCounts(baseline);
  return new Set([...tokenCounts(current)].filter(([token, count]) => count > (previous.get(token) ?? 0)).map(([token]) => token));
}
const scopedTokens = (inputs: PublicationBoundary['inputs']): string[][] =>
  inputs.flatMap(({ payload }) => payload.kind === 'text' ? [payload.tokens] : []);

export function novelPublicationInputs(current: PublicationBoundary, baseline: PublicationBoundary): PublicationBoundary['inputs'] {
  const additions = new Map<string, Set<string>>();
  for (const itemId of new Set(current.inputs.map(input => input.itemId))) {
    const previous = baseline.inputs.filter(input => input.itemId === itemId);
    const next = current.inputs.filter(input => input.itemId === itemId);
    const scoped = addedTokens(scopedTokens(next), scopedTokens(previous));
    const collected = addedTokens(next.map(input => input.collectedTokens), previous.map(input => input.collectedTokens));
    // Extraction boundaries and reclassification cannot turn previously collected data into new input.
    additions.set(itemId, new Set([...scoped].filter(token => collected.has(token))));
  }
  return current.inputs.filter(input => {
    const previous = baseline.inputs.filter(old => old.itemId === input.itemId);
    if (previous.some(old => old.collectedFingerprint === input.collectedFingerprint)) return false;
    const payload = input.payload;
    if (payload.kind === 'url') return !previous.some(old => old.collectedUrls.includes(payload.url)
      || old.payload.kind === 'url' && old.payload.url === payload.url);
    return payload.tokens.some(token => additions.get(input.itemId)?.has(token));
  });
}
