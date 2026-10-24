import { envInteger } from './research-fetch.js';
import { evidenceLinkSql } from '../sources/link-policy.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import type { ResearchPage } from './research-page.js';
import { publicationSnapshotSchema, generationReviewSchema, type GenerationReview } from '../types.js';
import { jevTemplates } from '../models/templates.js';
import { generationThread } from './generation-context.js';
import { publishedThread, type ThreadPost } from './publication-thread.js';
import { generationHistory } from './generation-history.js';

const accessSchema = z.enum(['public', 'restricted', 'unknown']);
const storySchema = z.object({
  id: z.uuid(), chosen_excerpt: z.string().nullable(), interest_score: z.number().int().min(1).max(10).nullable(),
  headline: z.string().nullable(), summary: z.string().nullable(), researched: z.boolean(),
  translated_excerpt: z.string().nullable(), content_version: z.number().int(), meaningful_hash: z.string().nullable(),
});
export const GENERATION_VERSION = 'generation-v14-retained-editions';
const timestampSchema = z.union([z.date().transform(value => value.toISOString()), z.iso.datetime({ offset: true })]);
const mentionSchema = z.object({ id: z.uuid(), text: z.string(), access: accessSchema, original_url: z.string().nullable(),
  media: z.array(z.unknown()).nullish(),
  source_name: z.string().optional(), connector_type: z.string().optional(),
  published_at: timestampSchema.nullable().optional(), collected_at: timestampSchema.nullable().optional(),
  referent_context: z.array(z.string().max(300)).max(3).optional() });
const storedMentionSchema = mentionSchema.extend({ parent_text: z.string().optional(), metadata: z.unknown().optional() });
const contextSpansSchema = z.object({ contextSpans: z.array(z.object({
  start: z.number().int().nonnegative(), end: z.number().int().nonnegative(),
})).max(100) });
const linkSchema = z.object({ url: z.string(), classification: z.enum(['relevant', 'uncertain']),
  access: accessSchema.optional(), original_url: z.string().nullable().optional(), source_name: z.string().optional() });
export type Story = z.infer<typeof storySchema>;
const supplementaryReportSchema = z.object({
  media: z.array(z.unknown()).nullish(),
  source_id: z.uuid(), revision_id: z.uuid(), text: z.string(), source_name: z.string(),
  original_url: z.string().nullable(), access: accessSchema,
  published_at: timestampSchema.nullable(), collected_at: timestampSchema.nullable(),
});
export type SupplementaryReport = z.infer<typeof supplementaryReportSchema>;
export interface StoryInput {
  story: Story; mentions: z.infer<typeof mentionSchema>[]; links: z.infer<typeof linkSchema>[];
  supplementary_reports?: SupplementaryReport[];
  previous_posts?: ThreadPost[];
}

/** Preserve the generation context IDs by applying the same offsets, limits and deduplication everywhere. */
export function mentionReferentContext(text: string, parentText: string | undefined, metadata: unknown): string[] {
  const referents = contextSpansSchema.safeParse(metadata);
  const context = referents.success && parentText ? referents.data.contextSpans.slice(0, 3).flatMap(span => {
    if (span.end <= span.start || span.end > parentText.length || span.end - span.start > 300) return [];
    const quote = parentText.slice(span.start, span.end);
    return quote.trim() && !text.includes(quote) ? [quote] : [];
  }) : [];
  return [...new Set(context)];
}

export async function loadStory(id: string): Promise<StoryInput> {
  return loadStoryWithQuery(id,db.query.bind(db));
}

export async function loadStoryWithQuery(id: string, query: typeof db.query): Promise<StoryInput> {
  z.uuid().parse(id);
  const stories = await query('SELECT id, chosen_excerpt, interest_score, headline, summary, researched, translated_excerpt, content_version, meaningful_hash FROM stories WHERE id = $1', [id]);
  const story = storySchema.parse(stories.rows[0]);
  const mentions = await query(`${generationThread} SELECT m.id, m.text, s.access, s.name AS source_name, s.connector_type, i.original_url, i.published_at, i.collected_at,
    m.metadata, r.metadata->'media' AS media, r.original_text AS parent_text FROM story_mentions m
    JOIN item_revisions r ON r.id = m.revision_id JOIN source_items i ON i.id = r.item_id AND (m.story_id<>$1 OR i.current_revision_id = r.id)
    JOIN sources s ON s.id = i.source_id WHERE m.story_id IN(SELECT id FROM generation_story_ids) ORDER BY m.created_at, m.id`, [id]);
  const links = await query(`${generationThread} SELECT DISTINCT l.url, ml.classification, so.access, i.original_url, so.name AS source_name FROM story_mentions m
    JOIN item_revisions r ON r.id = m.revision_id JOIN source_items i ON i.id = r.item_id AND (m.story_id<>$1 OR i.current_revision_id = r.id)
    JOIN sources so ON so.id=i.source_id
    JOIN mention_links ml ON ml.mention_id = m.id JOIN item_links l ON l.id = ml.link_id
    WHERE m.story_id IN(SELECT id FROM generation_story_ids) AND ml.classification <> 'irrelevant' AND ${evidenceLinkSql}
    UNION
    SELECT l.url, sl.classification, so.access, i.original_url, so.name AS source_name
    FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
    JOIN item_revisions r ON r.id=l.revision_id
    JOIN source_items i ON i.id=r.item_id AND (sl.story_id<>$1 OR i.current_revision_id=r.id) JOIN sources so ON so.id=i.source_id
    WHERE sl.story_id IN(SELECT id FROM generation_story_ids) AND sl.classification='relevant' AND ${evidenceLinkSql}
    ORDER BY classification, url`, [id]);
  const reports = await query(`${generationThread} SELECT DISTINCT so.id AS source_id, r.id AS revision_id,
      r.metadata->'media' AS media, r.original_text AS text, so.name AS source_name, i.original_url, so.access, i.published_at, i.collected_at
    FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
    JOIN item_revisions r ON r.id=l.revision_id
    JOIN source_items i ON i.id=r.item_id AND (sl.story_id<>$1 OR i.current_revision_id=r.id) JOIN sources so ON so.id=i.source_id
    WHERE sl.story_id IN(SELECT id FROM generation_story_ids) AND sl.classification='relevant' AND ${evidenceLinkSql}
      AND NOT EXISTS (SELECT 1 FROM story_mentions m WHERE m.story_id IN(SELECT id FROM generation_story_ids) AND m.revision_id=r.id)
      AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS (SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    ORDER BY i.published_at DESC NULLS LAST, i.collected_at DESC NULLS LAST, r.id`, [id]);
  const supplementaryReports = z.array(supplementaryReportSchema).parse(reports.rows);
  const previousPosts = await publishedThread(id, query);
  return { story, previous_posts: previousPosts, ...(supplementaryReports.length ? { supplementary_reports: supplementaryReports } : {}),
    mentions: z.array(storedMentionSchema).parse(mentions.rows).map(mention => {
    const { parent_text, metadata } = mention;
    const source = { id: mention.id, text: mention.text, access: mention.access, original_url: mention.original_url,
      source_name: mention.source_name, connector_type: mention.connector_type, published_at: mention.published_at, collected_at: mention.collected_at };
    const context = mentionReferentContext(source.text, parent_text, metadata);
    return { ...source, ...(mention.media?.length ? { media: mention.media } : {}), ...(context.length ? { referent_context: context } : {}) };
  }), links: z.array(linkSchema).parse(links.rows) };
}

export function generationHash(input: StoryInput, settings: AppSettings): string {
  return createHash('sha256').update(JSON.stringify({ stage: 'research', promptVersion: GENERATION_VERSION, researchPolicy: 'summary-review-v1',
    representativeVersion: jevTemplates.representative.version,
    mediaPolicy: { maxImages: envInteger('MEDIA_SUMMARY_MAX_IMAGES', 10, 10) },
    model: [settings.piProvider, settings.piModel, settings.modelVersion], contentVersion: input.story.content_version,
    content: input.story.meaningful_hash ?? { mentions: input.mentions.map(mention => mention.text) },
    links: input.links.map(link => [link.url, link.classification, link.access, link.original_url, link.source_name]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    supplementaryReports: (input.supplementary_reports ?? []).map(report => JSON.stringify(report)).sort(),
    previousPosts: generationHistory(input.previous_posts ?? []),
    excerpt: input.story.chosen_excerpt,
    headlineContext: [...new Set(input.mentions.map(mention => JSON.stringify({
      id: mention.id, text: mention.text, access: mention.access, source: mention.source_name, connector: mention.connector_type, url: mention.original_url,
      publishedAt: mention.published_at, collectedAt: mention.collected_at, media: mention.media, referents: mention.referent_context ?? [],
    })))].sort(),
    depth: { threshold: settings.researchThreshold,
      deep: (input.story.interest_score ?? 0) >= settings.researchThreshold,
      pages: settings.researchMaxPages, searches: settings.researchMaxSearches },
  })).digest('hex');
}

function isNoticeGeneration(value: unknown): boolean {
  const parsed = z.object({ summary: z.string().nullable().optional(), evidenceContract: z.object({
    verification: z.object({ method: z.string().optional() }).optional(),
  }).optional() }).safeParse(value);
  return parsed.success && (parsed.data.summary?.includes('Краткий пересказ недоступен') === true
    || parsed.data.evidenceContract?.verification?.method === 'exact_source_links');
}

export async function alreadyGenerated(input: StoryInput, settings: AppSettings, query = db.query.bind(db), receiptId?: string): Promise<boolean> {
  if (!input.story.headline || isNoticeGeneration(input.story)
    || !input.story.researched || !input.story.summary) return false;
  const result = await query<{ result: unknown }>(`SELECT result FROM judgments WHERE story_id = $1 AND stage = $2
    AND input_hash = $3 AND model_key = $4 AND prompt_version = '${GENERATION_VERSION}' AND expires_at > now()
    AND result->>'headline' = $5 AND result->>'summary' IS NOT DISTINCT FROM $6
    AND result->>'translatedExcerpt' IS NOT DISTINCT FROM $7 AND ($8::uuid IS NULL OR id=$8)
    ORDER BY created_at DESC,id DESC LIMIT 1`,
  [input.story.id, 'generation_research', generationHash(input, settings), `${settings.piProvider}/${settings.piModel}`,
    input.story.headline, input.story.summary, input.story.translated_excerpt,receiptId ?? null]);
  if (!result.rows.length) return false;
  if (isNoticeGeneration(result.rows[0]?.result)) return false;
  const signature = z.object({ evidenceSignature: z.string().min(1) }).safeParse(result.rows[0]?.result);
  return signature.success && signature.data.evidenceSignature === await evidenceSnapshotHash(input.story.id, query);
}

/** Read-only snapshot detects changed content, authority, timestamps, access and expiry. */
export async function evidenceSnapshotHash(storyId: string, query = db.query.bind(db)): Promise<string> {
  const result = await query(`${generationThread} SELECT DISTINCT e.id,e.url,e.canonical_url,e.title,e.content,e.access,e.metadata,
    se.role,se.assessment,e.expires_at>now() AS unexpired,se.relevance FROM story_evidence se
    JOIN evidence_documents e ON e.id=se.evidence_id WHERE se.story_id IN(SELECT id FROM generation_story_ids) AND se.superseded_at IS NULL ORDER BY e.id`, [storyId]);
  const rows = result.rows.flatMap((row: unknown) => {
    const parsed = evidenceSchema.safeParse(row);
    // Failed reads never enter the writer's sources; their short retry TTL cannot invalidate a draft.
    if (!parsed.success || !parsed.data.content?.trim() || parsed.data.access === 'unavailable') return [];
    const { relevance, ...legacy } = z.record(z.string(), z.unknown()).parse(row);
    const defaultRelevance = legacy.role === 'primary' || legacy.role === 'supporting' ? 'relevant' : 'uncertain';
    // Preserve pre-090 JSON bytes for backfilled defaults; only semantic changes add a field.
    return [relevance === undefined || relevance === defaultRelevance ? legacy : { ...legacy, relevance }];
  });
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export interface GeneratedStory {
  id: string; headline: string; summary: string | null; translatedExcerpt: string | null;
  evidenceSignature?: string;
  review?: GenerationReview;
  sourceUrls?: string[];
  primarySourceUrls?: string[];
}

export async function saveGenerations(inputs: StoryInput[], values: GeneratedStory[], settings: AppSettings): Promise<void> {
  await transaction(async client => {
    for (const value of values) {
      const input = inputs.find(candidate => candidate.story.id === value.id);
      if (!input) throw new Error('Generation result has no matching input');
      const signature = await evidenceSnapshotHash(value.id, client.query.bind(client));
      if (value.evidenceSignature !== undefined && value.evidenceSignature !== signature) {
        throw new Error('Evidence changed during generation');
      }
      if (value.review) generationReviewSchema.parse(value.review);
      if (value.sourceUrls) z.array(z.url({ protocol: /^https?$/u })).parse(value.sourceUrls);
      if (value.primarySourceUrls) z.array(z.url({ protocol: /^https?$/u })).parse(value.primarySourceUrls);
      const stored = { ...value, contentVersion: input.story.content_version, evidenceSignature: signature };
      const updated = await client.query(`UPDATE stories SET headline = $2, summary = $3, translated_excerpt = $4,
        researched = $5, updated_at = now() WHERE id = $1 AND content_version = $6
        AND chosen_excerpt IS NOT DISTINCT FROM $7 AND meaningful_hash IS NOT DISTINCT FROM $8 RETURNING id`,
      [value.id, value.headline, value.summary, value.translatedExcerpt, true,
        input.story.content_version, input.story.chosen_excerpt, input.story.meaningful_hash]);
      if (!updated.rows.length) throw new Error('Story changed during generation');
      await client.query(`INSERT INTO judgments
        (story_id, stage, input_hash, model_key, prompt_version, model_version, result, expires_at)
        VALUES ($1, $2, $3, $4, '${GENERATION_VERSION}', $5, $6, now() + $7 * interval '1 day')`,
      [value.id, 'generation_research', generationHash(input, settings),
        `${settings.piProvider}/${settings.piModel}`, settings.modelVersion, JSON.stringify(stored), settings.retentionDays]);
    }
  });
}

export const evidenceMetadataSchema = z.object({
  status: z.number().int().optional(), error: z.string().optional(), truncated: z.boolean().optional(),
  byline: z.string().nullable().optional(),
  paper: z.object({ id: z.string(), version: z.string().nullable(), extent: z.enum(['abstract', 'full_text']) }).optional(),
  method: z.enum(['crawl4ai', 'http']).optional(), contentFormat: z.enum(['markdown', 'html', 'text', 'json']).optional(),
  publishedAt: timestampSchema.nullable().optional(), updatedAt: timestampSchema.nullable().optional(),
  fetchedAt: timestampSchema.optional(), crawlerError: z.string().optional(),
}).passthrough();
const evidenceSchema = z.object({
  id: z.uuid(), url: z.string(), canonical_url: z.string().nullable(), title: z.string().nullable(),
  content: z.string().nullable(), access: z.enum(['public', 'restricted', 'unavailable', 'unknown']),
  role: z.enum(['primary', 'supporting', 'candidate']), assessment: z.string().nullable(),
  relevance: z.enum(['relevant', 'irrelevant', 'uncertain']).default('uncertain'),
  assessed_at: timestampSchema.nullable().optional(),
  metadata: evidenceMetadataSchema.optional(),
  published_at: timestampSchema.nullable().optional(), updated_at: timestampSchema.nullable().optional(),
  fetched_at: timestampSchema.nullable().optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
/** Corrupt document metadata is document-local, never an uncaught whole-batch validation error. */
export function parseEvidenceRows(rows: readonly unknown[]): Evidence[] {
  return rows.flatMap(row => {
    const parsed = evidenceSchema.safeParse(row);
    if (parsed.success) return [parsed.data];
    const object = z.record(z.string(), z.unknown()).safeParse(row);
    if (!object.success) return [];
    const unavailable = evidenceSchema.safeParse({ ...object.data, content: null, access: 'unavailable',
      role: 'candidate', relevance: 'uncertain', assessment: null, published_at: null, updated_at: null,
      fetched_at: null, assessed_at: null, metadata: { error: 'invalid_cached_evidence' } });
    return unavailable.success ? [unavailable.data] : [];
  });
}

/** Existing read material for origin classification. This does not fetch or mutate evidence. */
export async function loadCurrentEvidence(storyId:string):Promise<Evidence[]> {
  const result=await db.query(`SELECT e.id,e.url,e.canonical_url,e.title,e.content,e.access,se.role,se.relevance,se.assessment,se.assessed_at,
    e.metadata,e.metadata->>'publishedAt' AS published_at,e.metadata->>'updatedAt' AS updated_at,e.fetched_at
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id=$1 AND se.superseded_at IS NULL AND e.expires_at>now() ORDER BY e.fetched_at DESC`,[storyId]);
  return parseEvidenceRows(result.rows);
}

/** Retained ancestor reads remain event evidence even after their fetch-cache TTL expires. */
export async function loadPreviousEvidence(storyId: string): Promise<Evidence[]> {
  const result = await db.query(`${generationThread} SELECT DISTINCT e.id,e.url,e.canonical_url,e.title,e.content,e.access,
    se.role,se.relevance,se.assessment,se.assessed_at,e.metadata,
    e.metadata->>'publishedAt' AS published_at,e.metadata->>'updatedAt' AS updated_at,e.fetched_at
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id IN(SELECT id FROM generation_story_ids WHERE id<>$1) AND se.superseded_at IS NULL
    ORDER BY e.fetched_at DESC,e.id`, [storyId]);
  return parseEvidenceRows(result.rows);
}

export async function loadEvidence(storyId: string, researchInputHash: string): Promise<Evidence[]> {
  // Keep typed exclusions while stale content is refetched; a new assessment can supersede them.
  await db.query(`UPDATE story_evidence se SET superseded_at=coalesce(se.superseded_at,now()) FROM evidence_documents e
    WHERE se.story_id=$1 AND e.id=se.evidence_id AND se.relevance<>'irrelevant'
    AND (e.metadata->>'researchInputHash' IS DISTINCT FROM $2 OR e.expires_at<=now())`, [storyId, researchInputHash]);
  const result = await db.query(`SELECT e.id, e.url, e.canonical_url, e.title, e.content, e.access, se.role, se.relevance, se.assessment, se.assessed_at,
      e.metadata, e.metadata->>'publishedAt' AS published_at, e.metadata->>'updatedAt' AS updated_at, e.fetched_at
    FROM story_evidence se JOIN evidence_documents e ON e.id = se.evidence_id
    WHERE se.story_id = $1 AND se.superseded_at IS NULL AND e.expires_at > now() AND e.metadata->>'researchInputHash' = $2
    ORDER BY e.fetched_at DESC`, [storyId, researchInputHash]);
  return parseEvidenceRows(result.rows);
}

export async function saveEvidence(storyId: string, page: ResearchPage, settings: AppSettings,
  researchInputHash: string): Promise<Evidence> {
  const metadata = { ...page.metadata, originStoryId: storyId, publishedAt: page.publishedAt ?? page.metadata.publishedAt ?? null,
    updatedAt: page.updatedAt ?? page.metadata.updatedAt ?? null, fetchedAt: page.fetchedAt ?? page.metadata.fetchedAt,
    researchInputHash };
  return transaction(async client => {
    const result = await client.query<{ id: string; fetched_at: Date }>(`INSERT INTO evidence_documents
      (url, canonical_url, content_hash, title, content, access, expires_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, now() + $7 * interval '1 day', $8) RETURNING id, fetched_at`,
    [page.url, page.canonicalUrl, page.content ? createHash('sha256').update(page.content).digest('hex') : null,
      page.title, page.content, page.access, page.content && page.access === 'public' ? settings.retentionDays : Math.min(settings.retentionDays, 15 / 1440), JSON.stringify(metadata)]);
    const id = z.uuid().parse(result.rows[0]?.id);
    await client.query(`INSERT INTO story_evidence (story_id, evidence_id, role) VALUES ($1, $2, 'candidate')`, [storyId, id]);
    return { id, url: page.url, canonical_url: page.canonicalUrl, title: page.title, content: page.content,
      access: page.access, role: 'candidate', relevance: 'uncertain', assessment: null, metadata,
      published_at: page.publishedAt ?? page.metadata.publishedAt ?? null,
      updated_at: page.updatedAt ?? page.metadata.updatedAt ?? null,
      fetched_at: result.rows[0]?.fetched_at?.toISOString() ?? page.fetchedAt ?? null };
  });
}

export async function assessEvidence(storyId: string, evidence: Evidence, role: Evidence['role'], assessment: string,
  settings: AppSettings, relevance: Evidence['relevance']): Promise<Evidence> {
  // Failed/empty reads cannot establish either relevance or authority.
  if (evidence.access !== 'public' || !evidence.content?.trim()) relevance = 'uncertain';
  if (relevance !== 'relevant') role = 'candidate';
  const assessedAt = new Date().toISOString();
  await transaction(async client => {
    await client.query(`UPDATE story_evidence SET role = $3, assessment = $4, relevance = $5, assessed_at = $6, superseded_at = NULL,
      verified_at = CASE WHEN $3 = 'candidate' THEN NULL ELSE $6::timestamptz END WHERE story_id = $1 AND evidence_id = $2`,
    [storyId, evidence.id, role, assessment, relevance, assessedAt]);
    await client.query(`INSERT INTO judgments
      (story_id, stage, input_hash, model_key, prompt_version, model_version, result, expires_at)
      VALUES ($1, 'primary_assessment', $2, $3, 'primary-assessment-v6', $4, $5, now() + $6 * interval '1 day')`,
    [storyId, createHash('sha256').update(evidence.content ?? '').digest('hex'),
      `${settings.piProvider}/${settings.piModel}`, settings.modelVersion,
      JSON.stringify({ evidenceId: evidence.id, role, relevance, assessment }), settings.retentionDays]);
  });
  return { ...evidence, role, relevance, assessment, assessed_at: assessedAt };
}

/** Alias is a trusted SQL table name, never user input. */
export const unpublished = (alias: string): string => `NOT EXISTS(SELECT 1 FROM publications p
  WHERE p.story_id=${alias}.id AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL)`;

export interface PublishedStory { storyId: string; headline: string; summary: string; destinationId: string; messageId: string }

/** Read the actual posted copy, not a possibly stale story draft. */
export async function publishedStory(storyId: string, query = db.query.bind(db), destinationId?: string): Promise<PublishedStory | null> {
  const result = await query<{ content: unknown; destination_id: string; message_id: string }>(`SELECT snap.content,p.destination_id,p.message_id
    FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id
    WHERE p.story_id=$1 AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL
      AND ($2::text IS NULL OR p.destination_id=$2) ORDER BY p.published_at,p.id LIMIT 1`, [storyId,destinationId ?? null]);
  const row = result.rows[0];
  if (!row) return null;
  const snapshot = publicationSnapshotSchema.parse(row.content);
  return { storyId,headline:snapshot.headline,summary:snapshot.details,destinationId:row.destination_id,messageId:row.message_id };
}
