import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { classifyMediaRelevance, MEDIA_RELEVANCE_BATCH_SIZE, MEDIA_RELEVANCE_VERSION,
  type MediaStoryContext } from '../models/media-relevance.js';
import type { ModelImage } from '../models/images.js';
import { generationClient, recordGenerationFailure, requireInferenceApproval } from '../pipeline/generation-model.js';
import type { AppSettings } from '../settings.js';
import { compressModelImage, type MediaCandidate } from './comparison.js';

const contextSchema = z.object({
  headline: z.string().nullable(), summary: z.string().nullable(), chosen_excerpt: z.string().nullable(),
  mentions: z.array(z.object({ text: z.string(), access: z.string() })),
});

export function mediaRelevanceVersion(settings: AppSettings): string {
  return JSON.stringify({ policy: MEDIA_RELEVANCE_VERSION, encoding: 'full-image-webp90',
    batchSize: MEDIA_RELEVANCE_BATCH_SIZE, provider: settings.piProvider, model: settings.piModel,
    modelVersion: settings.modelVersion });
}

/** Only the requested story's extracted mentions, never the full roundup or ancestor stories. */
export async function loadMediaStoryContext(storyId: string): Promise<MediaStoryContext | null> {
  z.uuid().parse(storyId);
  let parsed: z.infer<typeof contextSchema>;
  try {
    const result = await db.query(`SELECT st.headline,st.summary,st.chosen_excerpt,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('text',m.text,'access',s.access) ORDER BY m.ordinal,m.id)
        FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
        JOIN source_items i ON i.id=r.item_id AND i.current_revision_id=r.id
        JOIN sources s ON s.id=i.source_id WHERE m.story_id=st.id
          AND r.metadata->>'pipelineFailure' IS DISTINCT FROM 'true'
          AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)),
        '[]'::jsonb) AS mentions FROM stories st WHERE st.id=$1`, [storyId]);
    parsed = contextSchema.parse(result.rows[0]);
  } catch {
    console.error('Story media context unavailable; omitting images.');
    return null;
  }
  // Check context access as well as attachment access, before sending any text to vision.
  await requireInferenceApproval(parsed.mentions.map(mention => mention.access), `media-context:${storyId}`);
  const context: MediaStoryContext = { headline: parsed.headline?.slice(0, 2_000) ?? null,
    summary: parsed.summary?.slice(0, 12_000) ?? null, chosenExcerpt: parsed.chosen_excerpt?.slice(0, 8_000) ?? null,
    mentions: parsed.mentions.slice(0, 12).map(mention => mention.text.slice(0, 4_000)) };
  return [context.headline, context.summary, context.chosenExcerpt, ...context.mentions].some(text => text?.trim())
    ? context : null;
}

/** Only positive, validated image decisions survive. Videos pass through without classification. */
export async function filterRelevantMedia(
  candidates: readonly MediaCandidate[], story: MediaStoryContext | null, storyId: string, settings: AppSettings,
): Promise<{ media: MediaCandidate[]; resolved: boolean }> {
  const images = candidates.filter(item => item.type === 'image');
  if (!images.length) return { media: [...candidates], resolved: true };
  if (!story) return { media: candidates.filter(item => item.type === 'video'), resolved: false };
  const kept = new Set<MediaCandidate>();
  let resolved = true;
  for (let offset = 0; offset < images.length; offset += MEDIA_RELEVANCE_BATCH_SIZE) {
    const batch: Array<{ candidate: MediaCandidate; image: ModelImage }> = [];
    for (const candidate of images.slice(offset, offset + MEDIA_RELEVANCE_BATCH_SIZE)) {
      try {
        batch.push({ candidate, image: { data: (await compressModelImage(candidate.data)).toString('base64'), mimeType: 'image/webp' } });
      } catch { resolved = false; }
    }
    if (!batch.length) continue;
    try {
      const identity = createHash('sha256').update(JSON.stringify(story));
      for (const { candidate } of batch) identity.update(candidate.data);
      const decisions = await classifyMediaRelevance(await generationClient(settings), story, batch.map(item => item.image),
        { operationId: `media-relevance:${storyId}:${identity.digest('hex')}`, stage: 'media-relevance' }, recordGenerationFailure);
      for (const decision of decisions) {
        if (decision.decision === 'unresolved') resolved = false;
        if (decision.decision === 'relevant') kept.add(batch[decision.attachment - 1]!.candidate);
      }
    } catch {
      resolved = false;
      console.error('Media relevance classification failed; omitting unresolved images.');
    }
  }
  return { media: candidates.filter(item => item.type === 'video' || kept.has(item)), resolved };
}
