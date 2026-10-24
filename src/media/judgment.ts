import { createHash } from 'node:crypto';
import { compressModelImage } from './comparison.js';
import { JevClient } from '../models/jev.js';
import { MEDIA_IDENTITY_EVIDENCE_VERSION, compareMediaIdentity } from '../models/media-identity.js';
import { generationClient, recordGenerationFailure } from '../pipeline/generation-model.js';
import { jevTemplates } from '../models/templates.js';
import type { MediaDecision } from './pair-cache.js';
import type { AppSettings } from '../settings.js';

/** Bump preparation when frame extraction, model-image encoding, or comparison policy changes. */
export function mediaJudgmentVersion(settings: AppSettings): string {
  return JSON.stringify({ preparation: 'media-pair-v1-full-rgba-webp90-third-frame',
    evidence: MEDIA_IDENTITY_EVIDENCE_VERSION, judgment: jevTemplates.media_identity,
    provider: settings.piProvider, vision: settings.piModel, modelVersion: settings.modelVersion,
    jevUrl: settings.jevUrl, jevModel: settings.jevModel,
    durationToleranceRatio: Number(process.env.MEDIA_VIDEO_DURATION_TOLERANCE ?? 0.2) });
}

/** JEV's text-only endpoint receives structured evidence from the vision model, not encoded pixels. */
export async function judgeMedia(left: Buffer, right: Buffer, storyId: string, settings: AppSettings): Promise<MediaDecision> {
  const jev = new JevClient({ baseUrl: settings.jevUrl, model: settings.jevModel, apiKey: process.env.JEV_API_KEY ?? '',
    timeoutMs: settings.jevTimeoutMs, connectTimeoutMs: settings.connectionTimeoutMs,
    prefixCache: settings.prefixCacheEnabled, requestMaxAttempts: settings.requestMaxAttempts,
    recordFailure: recordGenerationFailure });
  try {
    const pair = createHash('sha256').update(left).update(right).digest('hex');
    const compressed = await Promise.all([compressModelImage(left), compressModelImage(right)]);
    const result = await compareMediaIdentity(await generationClient(settings), jev, [
      { data: compressed[0]!.toString('base64'), mimeType: 'image/webp' },
      { data: compressed[1]!.toString('base64'), mimeType: 'image/webp' },
    ], { operationId: `media:${storyId}:${pair}` }, recordGenerationFailure);
    return result.decision;
  } catch {
    // An unavailable judge is not evidence of identity. Never discard either source on failure.
    console.error('Media identity comparison failed; retaining both attachments.');
    return 'unresolved';
  } finally { await jev.close(); }
}
