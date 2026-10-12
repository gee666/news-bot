import { z } from 'zod';
import type { PiRequest } from '../models/index.js';
import type { SourceConfirmationInput, SourceVerdict } from './source-links-confirmation.js';

const excerptSchema = z.object({ id: z.string(), text: z.string() });
export const sourceRequestSchema = z.object({ revision_id: z.string(), message: z.array(excerptSchema),
  candidates: z.array(z.object({ candidate_id: z.string(), story_id: z.string(), link_id: z.string(),
    url: z.array(excerptSchema), anchor: z.array(excerptSchema), story: z.array(excerptSchema) })) });

export function sourceInputFromRequest(request: PiRequest): SourceConfirmationInput {
  const value = sourceRequestSchema.parse(JSON.parse(request.prompt.split('\n')[0] ?? ''));
  return { ...value, message: value.message.map(excerpt => excerpt.text).join(''), candidates: value.candidates.map(candidate => ({
    ...candidate, url: candidate.url.map(excerpt => excerpt.text).join(''),
    anchor: candidate.anchor.map(excerpt => excerpt.text).join(''), story: candidate.story.map(excerpt => excerpt.text).join(''),
  })) };
}

/** Model fixture selecting passages containing the expected quotation, not generating quote text. */
export function sourceWireVerdicts(request: PiRequest, verdicts: SourceVerdict[]) {
  const input = sourceRequestSchema.parse(JSON.parse(request.prompt.split('\n')[0] ?? ''));
  return { items: Object.fromEntries(verdicts.map(verdict => {
    const candidate = input.candidates.find(value => value.candidate_id === verdict.candidate_id);
    if (!candidate) throw new Error('Unknown fixture candidate');
    const source = [...input.message, ...candidate.url, ...candidate.anchor].find(excerpt => excerpt.text.includes(verdict.source_quote));
    const story = candidate.story.find(excerpt => excerpt.text.includes(verdict.story_quote));
    if (!source || !story) throw new Error('Unknown fixture quotation');
    return [verdict.candidate_id, { verdict: verdict.verdict, reason: verdict.reason,
      source_excerpt_id: source.id, story_excerpt_id: story.id }];
  })) };
}
