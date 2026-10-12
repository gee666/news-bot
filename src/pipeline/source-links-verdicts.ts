import { z } from 'zod';
import type { SourceConfirmationInput, SourceVerdict } from './source-links-confirmation.js';

const QUOTE_CHARS = 500;
interface Excerpt { id: string; text: string }
export class SourceConfirmationEvidenceError extends Error {}

/** Keep all text, including whitespace, in order. Only nonblank passages can be cited. */
function excerpts(text: string, prefix: string): Excerpt[] {
  const result: Excerpt[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + QUOTE_CHARS, text.length);
    const boundary = /\n+|[.!?](?=\s)/u.exec(text.slice(start, end));
    if (boundary) end = start + boundary.index + boundary[0].length;
    else if (end < text.length) {
      const space = text.lastIndexOf(' ', end - 1);
      if (space > start) end = space + 1;
      // Do not split a UTF-16 surrogate pair when an unbroken passage reaches the limit.
      else if (/^[\uDC00-\uDFFF]$/u.test(text[end] ?? '')) end--;
    }
    result.push({ id: `${prefix}_${result.length}`, text: text.slice(start, end) });
    start = end;
  }
  return result;
}

function citations(passages: Excerpt[]): Map<string, string> {
  return new Map(passages.filter(passage => passage.text.trim()).map(passage => [passage.id, passage.text.trim()]));
}

/** Required candidate keys and per-candidate citation enums are part of the native JSON schema. */
export function sourceConfirmationRequest(input: SourceConfirmationInput) {
  const message = excerpts(input.message, 'message');
  const candidates = input.candidates.map(candidate => ({ ...candidate,
    url: excerpts(candidate.url, 'url'), anchor: excerpts(candidate.anchor, 'anchor'),
    story: excerpts(candidate.story, 'story') }));
  const evidence = candidates.map(candidate => ({ id: candidate.candidate_id,
    source: citations([...message, ...candidate.url, ...candidate.anchor]), story: citations(candidate.story) }));
  if (evidence.some(candidate => !candidate.source.size || !candidate.story.size)) {
    throw new SourceConfirmationEvidenceError('Source confirmation requires nonblank source and story evidence');
  }
  const validator = z.object({ items: z.object(Object.fromEntries(evidence.map(candidate => [candidate.id, z.object({
    verdict: z.enum(['relevant', 'irrelevant', 'uncertain']),
    reason: z.string().min(1).max(1000),
    source_excerpt_id: z.enum([...candidate.source.keys()]),
    story_excerpt_id: z.enum([...candidate.story.keys()]),
  }).strict()]))).strict() }).strict();
  return {
    prompt: JSON.stringify({ revision_id: input.revision_id, message, candidates }),
    validator,
    resolve(value: z.infer<typeof validator>): SourceVerdict[] {
      return evidence.map(candidate => {
        const verdict = value.items[candidate.id];
        const sourceQuote = verdict && candidate.source.get(verdict.source_excerpt_id);
        const storyQuote = verdict && candidate.story.get(verdict.story_excerpt_id);
        if (!verdict || !sourceQuote || !storyQuote) throw new Error('Missing source confirmation evidence');
        return { candidate_id: candidate.id, verdict: verdict.verdict, reason: verdict.reason,
          source_quote: sourceQuote, story_quote: storyQuote };
      });
    },
  };
}
