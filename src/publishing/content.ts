import type { PoolClient } from 'pg';
import { z } from 'zod';
import { orderSources } from './sources.js';
import { readFailure, usefulSourceTitle } from '../sources/read-quality.js';
import { evidenceMetadataSchema } from '../pipeline/generation-store.js';
import { fetchedRelevanceCte } from './source-relevance.js';
import { publicUrl } from '../pipeline/research-fetch.js';
import { sourceAuthorityRanks, generationReviewSchema, publicationSnapshotSchema, publicationSourceSchema, type PublicationSnapshot, type PublicationSource } from '../types.js';

const generationMetadataSchema = z.object({ review: generationReviewSchema.optional(),primarySourceUrls:z.array(z.string()).optional() });

export interface StoryContent {
  id: string; headline: string; summary: string | null; translated_excerpt: string | null;
  chosen_excerpt: string | null; researched: boolean; interest_score: number;
}
export const eligible = `s.status='completed' AND s.headline IS NOT NULL AND length(trim(s.headline))>0
  AND s.interest_score >= $2 AND NOT s.interest_stale AND s.profile_version=$3 AND s.model_version=$4
  AND ((s.researched AND s.summary IS NOT NULL AND length(trim(s.summary))>0)
    OR (NOT s.researched AND s.translated_excerpt IS NOT NULL AND length(trim(s.translated_excerpt))>0))`;

// Deduplicate destinations, retaining every distinct origin label in the resulting link.
export function mergeSources(input: PublicationSource[]): PublicationSource[] {
  const byUrl = new Map<string, PublicationSource>();
  const labels = new Map<string, Set<string>>();
  for (const source of publicationSourceSchema.array().parse(input)) {
    const atoms = source.labels ?? [source.label];
    const old = byUrl.get(source.url);
    if (!old) {
      const labelSet = new Set(atoms);
      byUrl.set(source.url, { ...source, label: [...labelSet].join(' / '), ...(source.labels ? { labels: [...labelSet] } : {}) });
      labels.set(source.url,labelSet); continue;
    }
    const labelSet = labels.get(source.url);
    for (const label of atoms) labelSet?.add(label);
    old.label = [...(labelSet ?? [])].join(' / ');
    if ((labelSet?.size ?? 0) > 1 || old.labels || source.labels) old.labels = [...(labelSet ?? [])];
    if (source.kind && (!old.kind || sourceAuthorityRanks[source.kind] < sourceAuthorityRanks[old.kind])) old.kind = source.kind;
    old.primary = old.kind ? old.kind === 'primary' : old.primary || source.primary;
    if (source.classification === 'relevant') old.classification = 'relevant';
    if (source.access === 'restricted' || source.url.startsWith('https://t.me/c/')) old.access = 'restricted';
  }
  return orderSources([...byUrl.values()]);
}

// These fields are written only after the publisher collector successfully reads a public article.
const collectedArticleSchema = z.object({
  connectorKind: z.enum(['feed', 'website']), canonicalUrl: z.url({ protocol: /^https?$/u }),
  title: z.string().nullable().optional(),
});

export async function sourceInventory(client: Pick<PoolClient, 'query'>, storyId: string): Promise<PublicationSource[]> {
  const sourceAssignments = `SELECT ml.link_id,ml.classification FROM story_mentions m
    JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.id=r.item_id
    JOIN mention_links ml ON ml.mention_id=m.id WHERE m.story_id=$1 AND i.current_revision_id=r.id
    UNION ALL SELECT sl.link_id,sl.classification FROM story_link_sources sl
    JOIN item_links l ON l.id=sl.link_id JOIN item_revisions r ON r.id=l.revision_id
    JOIN source_items i ON i.id=r.item_id WHERE sl.story_id=$1 AND i.current_revision_id=r.id`;
  const origins = await client.query<{ source_id: string; text: string; metadata: unknown; parent_text: string; name: string; external_id: string; original_url: string | null;
    connector_type: string; read_metadata: unknown; source_external_id: string; access: PublicationSource['access']; classification: PublicationSource['classification'] }>(`
    WITH source_assignments AS (${sourceAssignments}), source_revisions AS (
      SELECT m.revision_id,'mention:'||m.id AS source_id,m.text,m.metadata FROM story_mentions m WHERE m.story_id=$1
      UNION SELECT l.revision_id,'report:'||l.revision_id,r.original_text,NULL::jsonb FROM source_assignments a
        JOIN item_links l ON l.id=a.link_id JOIN item_revisions r ON r.id=l.revision_id
        WHERE a.classification='relevant' AND NOT EXISTS (
          SELECT 1 FROM story_mentions m WHERE m.story_id=$1 AND m.revision_id=l.revision_id)
    ) SELECT sr.source_id,sr.text,sr.metadata,r.original_text AS parent_text,src.name,i.external_id,i.original_url,src.connector_type,
      src.external_id AS source_external_id,src.access,r.metadata AS read_metadata,'relevant' AS classification
    FROM source_revisions sr JOIN item_revisions r ON r.id=sr.revision_id JOIN source_items i ON i.id=r.item_id
    JOIN sources src ON src.id=i.source_id WHERE i.current_revision_id=r.id
      AND (src.connector_type='telegram' OR (src.connector_type IN ('feed','website') AND src.access='public'
        AND r.metadata->>'connectorKind'=src.connector_type AND r.metadata->>'canonicalUrl' IS NOT NULL))
      AND length(trim(sr.text))>0 AND length(trim(r.original_text))>0
      AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    ORDER BY src.name,i.external_id,sr.source_id`, [storyId]);
  // A collected link is only a candidate. Publication requires a successful read and current event assessment.
  const evidence = await client.query<{ id: string; title: string | null; content: string; url: string; primary: boolean; metadata: unknown }>(`
    SELECT e.title,e.content,e.metadata,e.id,coalesce(e.canonical_url,e.url) AS url,(se.role='primary') AS primary
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id=$1 AND se.superseded_at IS NULL AND se.role IN ('primary','supporting') AND se.relevance='relevant'
      AND se.verified_at IS NOT NULL AND e.access='public' AND length(trim(e.content))>0
      AND e.expires_at>now() ORDER BY 6 DESC,5,1`, [storyId]);
  const verifiedSources: PublicationSource[] = evidence.rows.flatMap(row => {
    const metadata = evidenceMetadataSchema.safeParse(row.metadata);
    if (!metadata.success || readFailure(row.title,row.content,row.url,metadata.data)) return [];
    const label = usefulSourceTitle(row.title, row.content, row.url);
    if (!label) return [];
    return [{ label, url: row.url, primary: row.primary, access: 'public', classification: 'relevant' }];
  });
  const excludedLinks = await client.query<{ url: string }>(`WITH ${fetchedRelevanceCte}
    SELECT url FROM fetched_relevance WHERE relevance='irrelevant'`, [storyId]);
  const excludedUrls = new Set(excludedLinks.rows.map(row => row.url));
  const originSources: PublicationSource[] = [];
  for (const origin of origins.rows) {
    const telegramUrl = origin.connector_type === 'telegram' && /^-100\d+$/u.test(origin.source_external_id) && /^\d+$/u.test(origin.external_id)
      ? `https://t.me/c/${origin.source_external_id.slice(4)}/${origin.external_id}` : null;
    const url = origin.original_url ?? telegramUrl;
    if (!url) continue;
    let label = `${origin.name} · №${origin.external_id}`;
    if (origin.connector_type !== 'telegram') {
      const article = collectedArticleSchema.safeParse(origin.read_metadata);
      if (!article.success || article.data.connectorKind !== origin.connector_type || origin.access !== 'public'
        || readFailure(article.data.title ?? null, origin.parent_text, url, origin.read_metadata)) continue;
      // Redirects retain the original read identity, but exclusions apply to both known URLs.
      try {
        if (excludedUrls.has(publicUrl(url).href) || excludedUrls.has(publicUrl(article.data.canonicalUrl).href)) continue;
      } catch { continue; }
      label = usefulSourceTitle(article.data.title ?? null, origin.parent_text, url) ?? origin.name;
    }
    originSources.push({ label, url,
      access: url.startsWith('https://t.me/c/') ? 'restricted' : origin.access, primary: false, classification: origin.classification });
  }
  const admitted = (url: string) => !excludedUrls.has(url.split('#')[0] ?? url);
  return [...verifiedSources, ...originSources].filter(source => admitted(source.url));
}

export async function snapshotFor(client: Pick<PoolClient, 'query'>, story: StoryContent,
  receiptId?: string): Promise<PublicationSnapshot> {
  const inventory = await sourceInventory(client, story.id);
  const receipt = await client.query<{ result: unknown }>(`SELECT result FROM judgments WHERE story_id=$1
    AND stage='generation_research' AND result->>'headline'=$2 AND result->>'summary' IS NOT DISTINCT FROM $3
    AND ($4::uuid IS NULL OR id=$4) ORDER BY created_at DESC,id DESC LIMIT 1`,
  [story.id, story.headline, story.summary, receiptId ?? null]);
  const parsed = generationMetadataSchema.safeParse(receipt.rows[0]?.result);
  const metadata = parsed.success ? parsed.data : undefined;
  const primary=new Set(metadata?.primarySourceUrls ?? []);
  const referenced=primary.size ? await client.query<{url:string}>(`SELECT DISTINCT l.url FROM item_links l
    JOIN source_items i ON i.current_revision_id=l.revision_id WHERE l.url=ANY($2::text[]) AND (
      EXISTS(SELECT 1 FROM story_mentions m JOIN mention_links ml ON ml.mention_id=m.id
        WHERE m.story_id=$1 AND m.revision_id=l.revision_id AND ml.link_id=l.id AND ml.classification='relevant')
      OR EXISTS(SELECT 1 FROM story_link_sources sl WHERE sl.story_id=$1 AND sl.link_id=l.id AND sl.classification='relevant'))`,[story.id,[...primary]]) : {rows:[]};
  const sources = mergeSources([...inventory.map(source=>({...source,
    primary:metadata?.primarySourceUrls ? primary.has(source.url) : source.primary})),
    ...referenced.rows.map(({url})=>{const parsed=new URL(url);return {url,label:parsed.hostname+parsed.pathname,
      primary:true,access:'unknown' as const,classification:'relevant' as const};})]);
  for (const source of sources) delete source.labels;
  return publicationSnapshotSchema.parse({ headline: story.headline, score: story.interest_score,
    details: story.researched ? story.summary : story.translated_excerpt, detailsKind: story.researched ? 'summary' : 'excerpt', sources,
    ...(metadata?.review ? { review: metadata.review } : {}) });
}

