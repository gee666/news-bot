import { createHash } from 'node:crypto';
import { z } from 'zod';
import { evidenceLinkSql } from '../sources/links.js';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { requireInferenceApproval } from '../pipeline/generation-model.js';
import { envInteger } from '../pipeline/research-fetch.js';
import { MediaCache, MEDIA_TTL_MS } from './cache.js';
import { downloadMedia, mediaDescriptor } from './download.js';
import { deduplicateMedia, compressModelImage, sweepComparisonTemps, type MediaCandidate } from './comparison.js';
import { judgeMedia, mediaJudgmentVersion } from './judgment.js';
import { MediaPairCache } from './pair-cache.js';
import { distinctSourceMedia } from './source-images.js';
import { generationThread } from '../pipeline/generation-context.js';
import { filterRelevantMedia, loadMediaStoryContext, mediaRelevanceVersion } from './relevance.js';
import { isPublishableImage } from './codec.js';

// Selection policy changes must invalidate previously retained attachments.
const preparationVersion = 'media-v7-story-visual-relevance-dimensions';
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
    return parsed.success ? distinctSourceMedia(parsed.data).map(descriptor => ({ descriptor, source })) : [];
  });
  if (!descriptors.length) return [];
  await requireInferenceApproval(sources.map(source => source.access), `media:${storyId}`);
  const version = mediaJudgmentVersion(settings);
  const story = descriptors.some(({ descriptor }) => descriptor.type === 'image') ? await loadMediaStoryContext(storyId) : null;
  const fingerprint = createHash('sha256').update(JSON.stringify({ version: preparationVersion, judgment: version,
    relevance: mediaRelevanceVersion(settings), story, descriptors })).digest('hex');
  const cached = await cache.load(storyId, fingerprint);
  if (cached) return cached;
  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let resolved = true;
  for (const { descriptor, source } of descriptors) {
    const key = JSON.stringify([descriptor.type, descriptor.url ?? [source.source_metadata, descriptor.telegramMessageId]]);
    if (seen.has(key)) continue;
    seen.add(key);
    // Attachments are optional. A dead CDN URL or deleted Telegram file must not
    // discard the source text or spend the story's generation retry budget.
    try {
      const media = await downloadMedia(descriptor, { metadata: source.source_metadata });
      bytes += media.data.length;
      if (bytes > 256_000_000) {
        resolved = false;
        console.error('Story media download budget reached; omitting remaining attachments.');
        break;
      }
      if (media.type === 'image' && !await isPublishableImage(media.data)) continue;
      candidates.push({ ...media, expiresAt: Date.now() + MEDIA_TTL_MS });
    } catch {
      resolved = false;
      console.error('Source attachment unavailable; continuing without it.');
    }
  }
  const unique = await deduplicateMedia(candidates, async (left, right) => {
    const decision = await judgeMedia(left, right, storyId, settings);
    if (decision === 'unresolved') resolved = false;
    return decision;
  }, {
    pairCache: new MediaPairCache(version),
    durationToleranceRatio: Number(process.env.MEDIA_VIDEO_DURATION_TOLERANCE ?? 0.2),
  });
  const selection = await filterRelevantMedia(unique, story, storyId, settings);
  resolved &&= selection.resolved;
  // Keep the first-download deadline even on uncertainty. An incomplete fingerprint
  // can never satisfy a final-selection lookup, so the next publication retries.
  const expiresAt = await cache.save(storyId, resolved ? fingerprint : `unresolved:${fingerprint}`, selection.media);
  return selection.media.map(item => ({ ...item, expiresAt }));
}

export function publicationMedia(storyId: string, settings: AppSettings): Promise<MediaCandidate[]> {
  const key = `${storyId}:${mediaJudgmentVersion(settings)}:${mediaRelevanceVersion(settings)}:${process.env.ALLOW_PRIVATE_INFERENCE ?? ''}`;
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
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const candidate of media.filter(candidate => candidate.type === 'image').slice(0, limit)) {
    try {
      images.push({ data: (await compressModelImage(candidate.data)).toString('base64'), mimeType: 'image/webp' });
    } catch {
      console.error('Summary image encoding failed; continuing without it.');
    }
  }
  return images;
}

export async function releaseStoryMedia(storyId: string): Promise<void> {
  await Promise.all([...active].filter(([key]) => key.startsWith(`${storyId}:`)).map(([, task]) => task.catch(() => {})));
  await cache.release(storyId);
}

export async function cleanupMedia(): Promise<void> { await cache.sweep(); await new MediaPairCache('').sweep(); await sweepComparisonTemps(); }
