import { createHash } from 'node:crypto';
import { compressModelImage } from './comparison.js';
import { JevClient } from '../models/jev.js';
import { MEDIA_IDENTITY_VERSION, compareMediaIdentity } from '../models/media-identity.js';
import { recordGenerationFailure } from '../pipeline/generation-model.js';
import { jevTemplates } from '../models/templates.js';
import type { MediaDecision } from './pair-cache.js';
import type { AppSettings } from '../settings.js';

/** Bump preparation when frame extraction, model-image encoding, or comparison policy changes. */
export function mediaJudgmentVersion(settings: AppSettings): string {
  return JSON.stringify({ preparation: 'media-pair-v1-full-rgba-webp90-third-frame',
    comparison: MEDIA_IDENTITY_VERSION, judgment: jevTemplates.media_identity,
    modelVersion: settings.modelVersion,
    jevUrl: settings.jevUrl, jevModel: settings.jevModel, prefixCache: settings.prefixCacheEnabled,
    durationToleranceRatio: Number(process.env.MEDIA_VIDEO_DURATION_TOLERANCE ?? 0.2) });
}

/** Direct JEV image comparison. Uncertain or failed comparisons preserve both attachments. */
export async function judgeMedia(left: Buffer, right: Buffer, storyId: string, settings: AppSettings,
  signal?: AbortSignal): Promise<MediaDecision> {
  const jev = new JevClient({ baseUrl: settings.jevUrl, model: settings.jevModel, apiKey: process.env.JEV_API_KEY ?? '',
    timeoutMs: settings.jevTimeoutMs, connectTimeoutMs: settings.connectionTimeoutMs,
    prefixCache: settings.prefixCacheEnabled, requestMaxAttempts: settings.requestMaxAttempts,
    recordFailure: recordGenerationFailure });
  try {
    const pair = createHash('sha256').update(left).update(right).digest('hex');
    signal?.throwIfAborted();
    const options = signal ? { signal } : {};
    const compressed = await Promise.all([compressModelImage(left, options), compressModelImage(right, options)]);
    const result = await compareMediaIdentity(jev, [
      { data: compressed[0]!.toString('base64'), mimeType: 'image/webp' },
      { data: compressed[1]!.toString('base64'), mimeType: 'image/webp' },
    ], { operationId: `media:${storyId}:${pair}`, ...(signal ? { signal } : {}) }, recordGenerationFailure);
    return result.decision;
  } catch {
    // An unavailable judge is not evidence of identity. Never discard either source on failure.
    console.error('Media identity comparison failed; retaining both attachments.');
    return 'unresolved';
  } finally { await jev.close(); }
}
