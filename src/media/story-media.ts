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
import { judgeMedia } from './judgment.js';

const cache = new MediaCache();
const active = new Map<string, Promise<MediaCandidate[]>>();
const sourceSchema = z.object({ revision_id: z.string(), metadata: z.record(z.string(), z.unknown()),
  source_metadata: z.record(z.string(), z.unknown()), access: z.string() });

async function prepare(storyId: string, settings: AppSettings): Promise<MediaCandidate[]> {
  const result = await db.query(`SELECT DISTINCT r.id AS revision_id,r.metadata,s.metadata AS source_metadata,s.access
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id JOIN sources s ON s.id=i.source_id
    WHERE m.story_id=$1 AND i.collected_at>now()-interval '7 days'
    UNION SELECT r.id AS revision_id,r.metadata,s.metadata AS source_metadata,s.access
    FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
    JOIN item_revisions r ON r.id=l.revision_id JOIN source_items i ON i.current_revision_id=r.id
    JOIN sources s ON s.id=i.source_id WHERE sl.story_id=$1 AND sl.classification='relevant' AND ${evidenceLinkSql}
      AND i.collected_at>now()-interval '7 days' AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    UNION SELECT e.id AS revision_id,e.metadata,'{}'::jsonb AS source_metadata,e.access
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id=$1 AND se.relevance='relevant' AND e.access='public' AND e.fetched_at>now()-interval '7 days'
      AND se.superseded_at IS NULL AND e.expires_at>now()
    ORDER BY revision_id`, [z.uuid().parse(storyId)]);
  const sources = z.array(sourceSchema).parse(result.rows);
  const descriptors = sources.flatMap(source => {
    const parsed = z.array(mediaDescriptor).safeParse(source.metadata.media ?? []);
    return parsed.success ? parsed.data.map(descriptor => ({ descriptor, source })) : [];
  });
  if (!descriptors.length) return [];
  await requireInferenceApproval(sources.map(source => source.access), `media:${storyId}`);
  const fingerprint = createHash('sha256').update(JSON.stringify(descriptors)).digest('hex');
  const cached = await cache.load(storyId, fingerprint);
  if (cached) return cached;
  const candidates: MediaCandidate[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (const { descriptor, source } of descriptors) {
    const key = descriptor.url ?? JSON.stringify([source.source_metadata, descriptor.telegramMessageId]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 100) throw new Error('Story media exceeds 100 attachment processing limit');
    const media = await downloadMedia(descriptor, { metadata: source.source_metadata });
    bytes += media.data.length;
    if (bytes > 256_000_000) throw new Error('Story media exceeds 256 MB processing budget');
    candidates.push({ ...media, expiresAt: Date.now() + MEDIA_TTL_MS });
  }
  const unique = await deduplicateMedia(candidates, (left, right) => judgeMedia(left, right, storyId, settings), {
    durationToleranceRatio: Number(process.env.MEDIA_VIDEO_DURATION_TOLERANCE ?? 0.2),
  });
  const expiresAt = await cache.save(storyId, fingerprint, unique);
  return unique.map(item => ({ ...item, expiresAt }));
}

export function publicationMedia(storyId: string, settings: AppSettings): Promise<MediaCandidate[]> {
  const pending = active.get(storyId);
  if (pending) return pending;
  const task = prepare(storyId, settings).finally(() => { active.delete(storyId); });
  active.set(storyId, task);
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
  await active.get(storyId)?.catch(() => {});
  await cache.release(storyId);
}

export async function cleanupMedia(): Promise<void> { await cache.sweep(); await sweepComparisonTemps(); }
