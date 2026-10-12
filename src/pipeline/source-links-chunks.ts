import type { SourceConfirmationInput } from './source-links-confirmation.js';

// Bound reply size and isolate failed selections, not model input text.
export const SOURCE_CHUNK_CANDIDATES = 10;
export function sourceConfirmationChunks(input: SourceConfirmationInput): SourceConfirmationInput[] {
  const chunks: SourceConfirmationInput[] = [];
  for (let offset=0; offset<input.candidates.length; offset+=SOURCE_CHUNK_CANDIDATES) {
    chunks.push({ ...input,candidates: input.candidates.slice(offset,offset+SOURCE_CHUNK_CANDIDATES) });
  }
  return chunks;
}
