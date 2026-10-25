import { z } from 'zod';
import type { EventInput } from './consolidation-input.js';

export interface GroupingBudget { maxBytes: number; maxCandidates: number }
export function groupingBudget(): GroupingBudget {
  return {
    maxBytes: z.coerce.number().int().min(16_384).max(262_144).parse(process.env.GROUPING_MAX_PROMPT_BYTES ?? 98_304),
    maxCandidates: z.coerce.number().int().min(1).max(64).parse(process.env.GROUPING_MAX_CANDIDATES ?? 32),
  };
}

export function groupingPrompt(incoming: EventInput, candidates: readonly EventInput[]): string {
  // Aggregate text repeats report text. Fingerprints are local concurrency receipts,
  // not evidence. Send each report once with all its source URLs and links.
  const evidence = ({ id, reports }: EventInput) => ({ id, reports });
  return JSON.stringify({ incoming: evidence(incoming), candidates: candidates.map(evidence) });
}

/** Never truncate evidence or drop low-ranked candidates to make a request fit. */
export function groupingChunks(incoming: EventInput, candidates: readonly EventInput[],
  budget: GroupingBudget): EventInput[][] {
  const chunks: EventInput[][] = [];
  let chunk: EventInput[] = [];
  for (const candidate of candidates) {
    if (Buffer.byteLength(groupingPrompt(incoming, [candidate])) > budget.maxBytes) {
      throw new Error('A complete story pair exceeds the grouping prompt budget');
    }
    if (chunk.length && (chunk.length >= budget.maxCandidates
      || Buffer.byteLength(groupingPrompt(incoming, [...chunk, candidate])) > budget.maxBytes)) {
      chunks.push(chunk);
      chunk = [];
    }
    chunk.push(candidate);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}
