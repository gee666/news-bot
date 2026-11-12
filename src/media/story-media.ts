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
import { abortable, MediaDeadline } from './deadline.js';

// Selection policy changes must invalidate previously retained attachments.
const preparationVersion = 'media-v8-single-event-source-pictures';
const cache = new MediaCache();
const active = new Map<string, { deadline: MediaDeadline; task: Promise<MediaCandidate[]> }>();
const summaries = new Map<string, Set<MediaDeadline>>();
// Keep a release barrier until the actual filesystem operation settles, even if
// its caller has already stopped waiting. New work must not race a late removal.
const releasing = new Map<string, Promise<void>>();
const sourceSchema = z.object({ revision_id: z.string(), metadata: z.record(z.string(), z.unknown()),
  source_metadata: z.record(z.string(), z.unknown()), access: z.string(), own_media: z.boolean() });

async function prepare(storyId: string, settings: AppSettings, signal: AbortSignal): Promise<MediaCandidate[]> {
  signal.throwIfAborted();
  // Retention owns source lifetime. Fetch/cache TTLs must not hide retained ancestor attachments.
  const result = await db.query(`${generationThread}, single_event_sources AS (
    SELECT r.id FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id
    WHERE m.story_id IN(SELECT id FROM generation_story_ids)
      AND CASE WHEN jsonb_typeof(r.metadata->'pipelineExtraction')='array'
        THEN jsonb_array_length(r.metadata->'pipelineExtraction')=1 ELSE false END
  ) SELECT DISTINCT r.id AS revision_id,r.metadata,s.metadata AS source_metadata,s.access,
      r.id IN(SELECT id FROM single_event_sources) AS own_media
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.id=r.item_id AND (m.story_id<>$1 OR i.current_revision_id=r.id)
    JOIN sources s ON s.id=i.source_id
    WHERE m.story_id IN(SELECT id FROM generation_story_ids)
      AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    UNION SELECT r.id AS revision_id,r.metadata,s.metadata AS source_metadata,s.access,
      r.id IN(SELECT id FROM single_event_sources) AS own_media
    FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
    JOIN item_revisions r ON r.id=l.revision_id
    JOIN source_items i ON i.id=r.item_id AND (sl.story_id<>$1 OR i.current_revision_id=r.id)
    JOIN sources s ON s.id=i.source_id WHERE sl.story_id IN(SELECT id FROM generation_story_ids) AND sl.classification='relevant' AND ${evidenceLinkSql}
      AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
    UNION SELECT e.id AS revision_id,e.metadata,'{}'::jsonb AS source_metadata,e.access,false AS own_media
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id IN(SELECT id FROM generation_story_ids) AND se.relevance='relevant' AND e.access='public'
      AND se.superseded_at IS NULL AND (se.story_id<>$1 OR e.expires_at>now())
    ORDER BY revision_id`, [z.uuid().parse(storyId)]);
  signal.throwIfAborted();
  const sources = z.array(sourceSchema).parse(result.rows);
  // First-wins URL and visual dedup must retain the single-event provenance.
  const descriptors = sources.sort((a, b) => Number(b.own_media) - Number(a.own_media)).flatMap(source => {
    const parsed = z.array(mediaDescriptor).safeParse(source.metadata.media ?? []);
    return parsed.success ? distinctSourceMedia(parsed.data).map(descriptor => ({ descriptor, source })) : [];
  });
  if (!descriptors.length) return [];
  await requireInferenceApproval(sources.map(source => source.access), `media:${storyId}`);
  signal.throwIfAborted();
  const version = mediaJudgmentVersion(settings);
  const story = descriptors.some(({ descriptor }) => descriptor.type === 'image') ? await loadMediaStoryContext(storyId, signal) : null;
  signal.throwIfAborted();
  const fingerprint = createHash('sha256').update(JSON.stringify({ version: preparationVersion, judgment: version,
    relevance: mediaRelevanceVersion(settings), story, descriptors })).digest('hex');
  const cached = await cache.load(storyId, fingerprint, Date.now(), signal);
  signal.throwIfAborted();
  if (cached) return cached;
  const candidates: MediaCandidate[] = [];
  const ownMedia = new Set<MediaCandidate>();
  const seen = new Set<string>();
  let bytes = 0;
  let resolved = true;
  for (const { descriptor, source } of descriptors) {
    signal.throwIfAborted();
    const key = JSON.stringify([descriptor.type, descriptor.url ?? [source.source_metadata, descriptor.telegramMessageId]]);
    if (seen.has(key)) continue;
    seen.add(key);
    // Attachments are optional. A dead CDN URL or deleted Telegram file must not
    // discard the source text or spend the story's generation retry budget.
    try {
      const media = await abortable(signal, () => downloadMedia(descriptor, { metadata: source.source_metadata }, signal));
      signal.throwIfAborted();
      bytes += media.data.length;
      if (bytes > 256_000_000) {
        resolved = false;
        console.error('Story media download budget reached; omitting remaining attachments.');
        break;
      }
      if (media.type === 'image' && !await isPublishableImage(media.data, { signal })) {
        signal.throwIfAborted();
        continue;
      }
      signal.throwIfAborted();
      const candidate = { ...media, expiresAt: Date.now() + MEDIA_TTL_MS };
      candidates.push(candidate);
      if (source.own_media) ownMedia.add(candidate);
    } catch {
      signal.throwIfAborted();
      resolved = false;
      console.error('Source attachment unavailable; continuing without it.');
    }
  }
  signal.throwIfAborted();
  const unique = await abortable(signal, () => deduplicateMedia(candidates, async (left, right) => {
    signal.throwIfAborted();
    const decision = await abortable(signal, () => judgeMedia(left, right, storyId, settings, signal));
    signal.throwIfAborted();
    if (decision === 'unresolved') resolved = false;
    return decision;
  }, {
    signal, pairCache: new MediaPairCache(version),
    durationToleranceRatio: Number(process.env.MEDIA_VIDEO_DURATION_TOLERANCE ?? 0.2),
  }));
  signal.throwIfAborted();
  const selection = await abortable(signal, () => filterRelevantMedia(unique.filter(item => !ownMedia.has(item)), story, storyId, settings, signal));
  signal.throwIfAborted();
  const retained = [...unique.filter(item => ownMedia.has(item)), ...selection.media];
  resolved &&= selection.resolved;
  // Keep the first-download deadline even on uncertainty. An incomplete fingerprint
  // can never satisfy a final-selection lookup, so the next publication retries.
  const expiresAt = await cache.save(storyId, resolved ? fingerprint : `unresolved:${fingerprint}`, retained, Date.now(), signal);
  signal.throwIfAborted();
  return retained.map(item => ({ ...item, expiresAt }));
}

export function publicationMedia(storyId: string, settings: AppSettings): Promise<MediaCandidate[]> {
  if (releasing.has(storyId)) return Promise.resolve([]);
  const key = `${storyId}:${mediaJudgmentVersion(settings)}:${mediaRelevanceVersion(settings)}:${process.env.ALLOW_PRIVATE_INFERENCE ?? ''}`;
  const pending = active.get(key);
  if (pending) return pending.task;
  const deadline = new MediaDeadline();
  const task = deadline.run(() => prepare(storyId, settings, deadline.signal)).catch(() => {
    // Privacy failures also omit all media. They never bypass the approval check.
    deadline.abort();
    console.error('Story media preparation failed or expired; continuing text-only.');
    return [];
  }).finally(() => {
    deadline.dispose();
    if (active.get(key)?.task === task) active.delete(key);
  });
  active.set(key, { deadline, task });
  return task;
}

/** Video and extracted video frames never enter editorial summarization. */
export async function summaryImages(storyId: string, settings: AppSettings): Promise<Array<{ data: string; mimeType: string }>> {
  const limit = envInteger('MEDIA_SUMMARY_MAX_IMAGES', 10, 10);
  const deadline = new MediaDeadline();
  const tracked = summaries.get(storyId) ?? new Set<MediaDeadline>();
  summaries.set(storyId, tracked);
  tracked.add(deadline);
  const abortPreparation = () => {
    for (const [key, pending] of active) if (key.startsWith(`${storyId}:`)) pending.deadline.abort();
  };
  deadline.signal.addEventListener('abort', abortPreparation, { once: true });
  try {
    return await deadline.run(async () => {
      const media = await publicationMedia(storyId, settings);
      deadline.signal.throwIfAborted();
      const images: Array<{ data: string; mimeType: string }> = [];
      for (const candidate of media.filter(candidate => candidate.type === 'image').slice(0, limit)) {
        deadline.signal.throwIfAborted();
        try {
          const data = await abortable(deadline.signal, () => compressModelImage(candidate.data, { signal: deadline.signal }));
          deadline.signal.throwIfAborted();
          images.push({ data: data.toString('base64'), mimeType: 'image/webp' });
        } catch {
          deadline.signal.throwIfAborted();
          console.error('Summary image encoding failed; continuing without it.');
        }
      }
      return images;
    });
  } catch {
    deadline.abort();
    console.error('Summary media preparation failed or expired; continuing text-only.');
    return [];
  } finally {
    deadline.dispose();
    deadline.signal.removeEventListener('abort', abortPreparation);
    tracked.delete(deadline);
    if (!tracked.size) summaries.delete(storyId);
  }
}

export async function releaseStoryMedia(storyId: string): Promise<void> {
  for (const [key, pending] of active) if (key.startsWith(`${storyId}:`)) pending.deadline.abort();
  for (const deadline of summaries.get(storyId) ?? []) deadline.abort();
  const deadline = new MediaDeadline();
  let task = releasing.get(storyId);
  if (!task) {
    task = cache.release(storyId).catch(() => {
      console.error('Story media cleanup failed; a later sweep will retry.');
    }).finally(() => { if (releasing.get(storyId) === task) releasing.delete(storyId); });
    releasing.set(storyId, task);
  }
  try { await deadline.run(() => task); }
  catch { console.error('Story media cleanup expired; a later sweep will retry.'); }
  finally { deadline.dispose(); }
}

export async function cleanupMedia(): Promise<void> {
  await cache.sweep(Date.now(), async storyId => {
    const result = await db.query('SELECT id FROM stories WHERE id=$1', [storyId]);
    return result.rows.length > 0;
  });
  await new MediaPairCache('').sweep();
  await sweepComparisonTemps();
}
