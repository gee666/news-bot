import { z } from 'zod';
import type { ModelImage } from './images.js';
import { jevImagePayload } from './jev-images.js';
import type { RequestContext } from './inference.js';
import type { JevClient } from './jev.js';

export const MEDIA_RELEVANCE_VERSION = 'story-visual-relevance-v2-direct-jev';
export const MEDIA_RELEVANCE_BATCH_SIZE = 1;
export interface MediaStoryContext {
  headline: string | null;
  summary: string | null;
  chosenExcerpt: string | null;
  mentions: string[];
}
export interface MediaRelevanceDecision {
  attachment: number;
  decision: 'relevant' | 'irrelevant' | 'unresolved';
}

/** JEV sees the complete attachment and the specific story, not an OpenAI description. */
export async function classifyMediaRelevance(
  jev: Pick<JevClient, 'judge'>, story: MediaStoryContext, images: readonly ModelImage[],
  context: RequestContext,
): Promise<MediaRelevanceDecision[]> {
  z.array(z.unknown()).length(MEDIA_RELEVANCE_BATCH_SIZE).parse(images);
  jevImagePayload(images);
  context.signal?.throwIfAborted();
  const result = await jev.judge('media_relevance', { story }, context, images);
  context.signal?.throwIfAborted();
  const answer = result.answers.relation;
  if (!answer || answer.type !== 'choice') throw new Error('Invalid media relevance decision');
  return [{ attachment: 1, decision: z.enum(['relevant', 'irrelevant', 'unresolved']).parse(answer.choice) }];
}
