import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Nodes } from 'mdast';
import { db } from '../db.js';
import { evidenceLinkSql } from '../sources/links.js';
import { markdownTree } from '../sources/markdown.js';
import { primaryEventDateSchema, primaryEventDates } from './event-dates.js';
import { imageEvidenceSchema, imageEvidenceText } from '../pipeline/extraction-evidence.js';

const imageHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const imageEventSchema = z.object({ kind: z.literal('image'), imageEvidence: z.array(imageEvidenceSchema).min(1) });

const reportSchema = z.object({
  item_id: z.uuid(), content_hash: z.string(), text: z.string(),
  source_time: z.coerce.date(), revision_time: z.coerce.date().optional(), urls: z.array(z.url()),
  collected_text: z.string().optional(), collected_urls: z.array(z.url()).optional(),
  image_evidence: z.unknown().optional(), extraction: z.unknown().optional(),
});
const payloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), tokens: z.array(z.string().min(1)).min(1) }).strict(),
  z.object({ kind: z.literal('url'), url: z.url({ protocol: /^https?$/u }) }).strict(),
  z.object({ kind: z.literal('image'), sha256: imageHashSchema, tokens: z.array(z.string().min(1)).min(1) }).strict(),
]);
export const publicationBoundarySchema = z.object({ version: z.literal('publication-input-v2'),
  // Informational primary dates may be unknown or absent in saved v2 boundaries.
  primaryEventDates: z.array(primaryEventDateSchema).optional(),
  inputs: z.array(z.object({ itemId: z.uuid(), contentHash: z.string(), payload: payloadSchema,
    sourceTime: z.iso.datetime(), revisionTime: z.iso.datetime().optional(),
    collectedTokens: z.array(z.string().min(1)), collectedUrls: z.array(z.url()),
    collectedImageHashes: z.array(imageHashSchema).optional(), collectedCaptionTokens: z.array(z.string().min(1)).optional(),
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
    const extraction = z.array(z.unknown()).safeParse(row.extraction);
    const committed = (extraction.success ? extraction.data : []).flatMap(event => {
      const visual = imageEventSchema.safeParse(event);
      return visual.success ? visual.data.imageEvidence : [];
    });
    const visual = z.array(imageEvidenceSchema).safeParse(row.image_evidence ?? []);
    // A mention alone cannot invent visual provenance. It must match the revision's saved receipt.
    if (!visual.success || visual.data.some(fact => !committed.some(saved => JSON.stringify(saved) === JSON.stringify(fact)))) continue;
    const visualText = imageEvidenceText(visual.data);
    if (visualText && !row.text.endsWith(visualText)) continue;
    const text = visualText ? row.text.slice(0, -visualText.length).trim() : row.text;
    const tokens = publicationTextTokens(text);
    const collectedText = row.collected_text ?? text;
    const collectedUrls = [...new Set(row.collected_urls ?? row.urls)].sort();
    const collectedImageHashes = [...new Set(committed.flatMap(fact => fact.images.map(image => image.sourceSha256)))].sort();
    // Generated observations are not collection changes. Hash original bytes, not wording or transcodes.
    const collectedFingerprint = createHash('sha256').update(JSON.stringify({
      text: collectedText.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(), urls: collectedUrls,
      ...(collectedImageHashes.length ? { images: collectedImageHashes } : {}),
    })).digest('hex');
    const payloads: Array<z.infer<typeof payloadSchema>> = [
      ...(tokens.length ? [{ kind: 'text' as const, tokens }] : []),
      ...row.urls.map(url => ({ kind: 'url' as const, url })),
      ...visual.data.flatMap(fact => fact.images.map(image => ({ kind: 'image' as const,
        sha256: image.sourceSha256, tokens: publicationTextTokens(fact.text) }))).filter(payload => payload.tokens.length),
    ];
    const collectedTokens = publicationTextTokens([collectedText, ...committed.map(fact => fact.text)].join('\n'));
    for (const payload of payloads) {
      const key = JSON.stringify([row.item_id, payload]);
      if (seen.has(key)) continue;
      seen.add(key);
      inputs.push({ itemId: row.item_id, contentHash: row.content_hash, sourceTime: row.source_time.toISOString(),
        ...(row.revision_time ? { revisionTime: row.revision_time.toISOString() } : {}), payload,
        collectedTokens, collectedUrls, collectedFingerprint,
        ...(collectedImageHashes.length ? { collectedImageHashes, collectedCaptionTokens: publicationTextTokens(collectedText) } : {}) });
    }
  }
  return { version: 'publication-input-v2', inputs, primaryEventDates: [] };
}

/** Retention is immutable; a refetch must not make an undated report recent again. */
const sourceInputTime = 'coalesce(i.published_at,least(i.collected_at,i.retention_at))';

export async function publicationInputBoundary(storyId: string, query = db.query.bind(db)): Promise<PublicationBoundary> {
  const rows = await query(`WITH scoped AS (
    SELECT m.revision_id,m.text,m.metadata->'imageEvidence' AS image_evidence,
      coalesce((SELECT jsonb_agg(DISTINCT l.url ORDER BY l.url) FROM mention_links ml
        JOIN item_links l ON l.id=ml.link_id WHERE ml.mention_id=m.id
          AND ml.classification='relevant' AND ${evidenceLinkSql}),'[]'::jsonb) AS urls
      FROM story_mentions m WHERE m.story_id=$1 AND length(trim(m.text))>0
  ) SELECT i.id AS item_id,r.content_hash,scoped.text,scoped.urls,scoped.image_evidence,
    r.metadata->'pipelineExtraction' AS extraction,r.normalized_text AS collected_text,
    coalesce((SELECT jsonb_agg(DISTINCT l.url ORDER BY l.url) FROM item_links l
      WHERE l.revision_id=r.id),'[]'::jsonb) AS collected_urls,
    ${sourceInputTime} AS source_time,r.created_at AS revision_time
    FROM scoped JOIN item_revisions r ON r.id=scoped.revision_id JOIN source_items i ON i.current_revision_id=r.id
    WHERE r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    ORDER BY i.id,scoped.text,scoped.urls::text`, [storyId]);
  return { ...reportBoundary(rows.rows), primaryEventDates: await primaryEventDates(storyId, query) };
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
    const collected = addedTokens(next.map(input => input.collectedCaptionTokens ?? input.collectedTokens),
      previous.map(input => input.collectedCaptionTokens ?? input.collectedTokens));
    // Extraction boundaries and reclassification cannot turn previously collected data into new input.
    additions.set(itemId, new Set([...scoped].filter(token => collected.has(token))));
  }
  // Retired source-only associations saved URL payloads without extracted report text.
  // Apply this to frozen boundaries too, without adopting any of today's attachments.
  const reports = new Set(current.inputs.filter(input => input.payload.kind === 'text' || input.payload.kind === 'image')
    .map(input => JSON.stringify([input.itemId, input.contentHash])));
  return current.inputs.filter(input => {
    if (!reports.has(JSON.stringify([input.itemId, input.contentHash]))) return false;
    const previous = baseline.inputs.filter(old => old.itemId === input.itemId);
    if (previous.some(old => old.collectedFingerprint === input.collectedFingerprint)) return false;
    const payload = input.payload;
    if (payload.kind === 'image') return !previous.some(old => old.collectedImageHashes?.includes(payload.sha256)
      || old.payload.kind === 'image' && old.payload.sha256 === payload.sha256);
    if (payload.kind === 'url') return !previous.some(old => old.collectedUrls.includes(payload.url)
      || old.payload.kind === 'url' && old.payload.url === payload.url);
    return payload.tokens.some(token => additions.get(input.itemId)?.has(token));
  });
}
