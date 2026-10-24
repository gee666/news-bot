import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evidenceLinkSql } from '../sources/link-policy.js';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { requireInferenceApproval } from '../pipeline/generation-model.js';
import { envInteger } from '../pipeline/research-fetch.js';
import { MediaCache, MEDIA_TTL_MS } from './cache.js';
import { downloadMedia, mediaDescriptor } from './download.js';
import { deduplicateMedia, compressModelImage, sweepComparisonTemps, type MediaCandidate } from './comparison.js';
import { judgeMedia, mediaJudgmentVersion } from './judgment.js';
import { MediaPairCache } from './pair-cache.js';
import { generationThread } from '../pipeline/generation-context.js';

// Codec changes must invalidate selections made while visual comparisons were rejected.
const preparationVersion = 'media-v4-retained-ancestry';
const cache = new MediaCache();
const active = new Map<string, Promise<MediaCandidate[]>>();
const sourceSchema = z.object({ revision_id: z.string(), metadata: z.record(z.string(), z.unknown()),
  source_metadata: z.record(z.string(), z.unknown()), access: z.string() });

async function prepare(storyId: string, settings: AppSettings): Promise<MediaCandidate[]> {
  // Retention owns source lifetime. Fetch/cache TTLs must not hide retained ancestor attachments.
  const result = await db.query(`${generationThread} SELECT DISTINCT r.id AS revision_id,r.metadata,s.metadata AS source_metadata,s.access
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.id=r.item_id AND (m.story_id<>$1 OR i.current_revision_id=r.id)
    JOIN sources s ON s.id=i.source_id
    WHERE m.story_id IN(SELECT id FROM generation_story_ids)
      AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    UNION SELECT r.id AS revision_id,r.metadata,s.metadata AS source_metadata,s.access
    FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
    JOIN item_revisions r ON r.id=l.revision_id
    JOIN source_items i ON i.id=r.item_id AND (sl.story_id<>$1 OR i.current_revision_id=r.id)
    JOIN sources s ON s.id=i.source_id WHERE sl.story_id IN(SELECT id FROM generation_story_ids) AND sl.classification='relevant' AND ${evidenceLinkSql}
      AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    UNION SELECT e.id AS revision_id,e.metadata,'{}'::jsonb AS source_metadata,e.access
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id IN(SELECT id FROM generation_story_ids) AND se.relevance='relevant' AND e.access='public'
      AND se.superseded_at IS NULL AND (se.story_id<>$1 OR e.expires_at>now())
    ORDER BY revision_id`, [z.uuid().parse(storyId)]);
  const sources = z.array(sourceSchema).parse(result.rows);
  const descriptors = sources.flatMap(source => {
    const parsed = z.array(mediaDescriptor).safeParse(source.metadata.media ?? []);
    return parsed.success ? parsed.data.map(descriptor => ({ descriptor, source })) : [];
  });
  if (!descriptors.length) return [];
  await requireInferenceApproval(sources.map(source => source.access), `media:${storyId}`);
  const version = mediaJudgmentVersion(settings);
  const fingerprint = createHash('sha256').update(JSON.stringify({ version: preparationVersion, judgment: version, descriptors })).digest('hex');
  const cached = await cache.load(storyId, fingerprint);
  if (cached) return cached;
  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const { descriptor, source } of descriptors) {
    const key = JSON.stringify([descriptor.type, descriptor.url ?? [source.source_metadata, descriptor.telegramMessageId]]);
    if (seen.has(key)) continue;
    seen.add(key);
    const media = await downloadMedia(descriptor, { metadata: source.source_metadata });
    bytes += media.data.length;
    if (bytes > 256_000_000) throw new Error('Story media exceeds 256 MB processing budget');
    candidates.push({ ...media, expiresAt: Date.now() + MEDIA_TTL_MS });
  }
  let resolved = true;
  const unique = await deduplicateMedia(candidates, async (left, right) => {
    const decision = await judgeMedia(left, right, storyId, settings);
    if (decision === 'unresolved') resolved = false;
    return decision;
  }, {
    pairCache: new MediaPairCache(version),
    durationToleranceRatio: Number(process.env.MEDIA_VIDEO_DURATION_TOLERANCE ?? 0.2),
  });
  // Keep the first-download deadline even on uncertainty. An incomplete fingerprint
  // can never satisfy a final-selection lookup, so the next publication retries.
  const expiresAt = await cache.save(storyId, resolved ? fingerprint : `unresolved:${fingerprint}`, unique);
  return unique.map(item => ({ ...item, expiresAt }));
}

export function publicationMedia(storyId: string, settings: AppSettings): Promise<MediaCandidate[]> {
  const key = `${storyId}:${mediaJudgmentVersion(settings)}:${process.env.ALLOW_PRIVATE_INFERENCE ?? ''}`;
  const pending = active.get(key);
  if (pending) return pending;
  const task = prepare(storyId, settings).finally(() => { active.delete(key); });
  active.set(key, task);
  return task;
}

/** Video and extracted video frames never enter editorial summarization. */
export async function summaryImages(storyId: string, settings: AppSettings): Promise<Array<{ data: string; mimeType: string }>> {
  const limit = envInteger('MEDIA_SUMMARY_MAX_IMAGES', 10, 10);
  const media = await publicationMedia(storyId, settings);
  return Promise.all(media.filter(candidate => candidate.type === 'image').slice(0, limit).map(async candidate => ({
    data: (await compressModelImage(candidate.data)).toString('base64'), mimeType: 'image/webp',
  })));
}

export async function releaseStoryMedia(storyId: string): Promise<void> {
  await Promise.all([...active].filter(([key]) => key.startsWith(`${storyId}:`)).map(([, task]) => task.catch(() => {})));
  await cache.release(storyId);
}

export async function cleanupMedia(): Promise<void> { await cache.sweep(); await new MediaPairCache('').sweep(); await sweepComparisonTemps(); }
