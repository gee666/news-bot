import { z } from 'zod';
import { failureMetadata, ModelRequestError, RequestFault } from './errors.js';
import { jevImagePayload } from './jev-images.js';
import type { ModelImage } from './images.js';
import type { FailureRecorder, RequestContext } from './inference.js';
import type { JevClient, JevResult } from './jev.js';

export const MEDIA_IDENTITY_VERSION = 'media-identity-direct-images-v3';
export interface MediaIdentityResult {
  decision: 'same' | 'different' | 'unresolved';
  judgment: JevResult;
}

/** One direct JEV call with two ordered whole-canvas attachments. No description or generation stage. */
export async function compareMediaIdentity(
  jev: Pick<JevClient, 'judge'>,
  images: readonly [ModelImage, ModelImage],
  context: RequestContext,
  recordFailure: FailureRecorder,
): Promise<MediaIdentityResult> {
  const judgmentContext = { ...context, operationId: context.operationId + ':jev',
    ...(context.stage ? { stage: context.stage + ':jev' } : {}) };
  try {
    if (!z.array(z.unknown()).length(2).safeParse(images).success) {
      throw new RequestFault('invalid_request', { outcome: 'not_submitted' });
    }
    jevImagePayload(images);
  } catch {
    const failure = failureMetadata(new RequestFault('invalid_request', { outcome: 'not_submitted' }),
      judgmentContext.operationId, 'jev', context.attempt ?? 1, 0);
    await recordFailure(failure);
    throw new ModelRequestError(failure);
  }
  const judgment = await jev.judge('media_identity', { comparisonVersion: MEDIA_IDENTITY_VERSION }, judgmentContext, images);
  const answer = judgment.answers.relation;
  const decision = z.enum(['same', 'different', 'unresolved']).safeParse(answer?.type === 'choice' ? answer.choice : undefined);
  if (!decision.success) {
    const failure = failureMetadata(new RequestFault('invalid_output', { outcome: 'rejected' }),
      judgmentContext.operationId, 'jev', context.attempt ?? 1, judgment.metrics.durationMs);
    await recordFailure(failure);
    throw new ModelRequestError(failure);
  }
  return { decision: decision.data, judgment };
}
