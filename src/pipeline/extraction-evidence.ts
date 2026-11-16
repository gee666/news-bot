import { z } from 'zod';
import type { ModelImage } from '../models/images.js';
import { mediaDescriptor } from '../media/download.js';

/** Hashes identify both the downloaded attachment and the exact model input. */
export const imageProvenanceSchema = z.object({
  id: z.string().regex(/^i\d+$/u),
  descriptor: mediaDescriptor.extend({ type: z.literal('image') }).strict(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  modelSha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type ImageProvenance = z.infer<typeof imageProvenanceSchema>;
export interface ExtractionImage { image: ModelImage; provenance: ImageProvenance }
export const imageEvidenceSchema = z.object({
  text: z.string().trim().min(1).max(12_000),
  images: z.array(imageProvenanceSchema).min(1).max(10),
}).strict();
export type ImageEvidence = z.infer<typeof imageEvidenceSchema>;

/** The label survives downstream text-only matching, research and generation. */
export function imageEvidenceText(evidence: readonly ImageEvidence[]): string {
  return evidence.map(fact => `[Image-derived report, ${fact.images.map(image => image.id).join(', ')}; not a source-text quotation]\n${fact.text}`).join('\n\n');
}
