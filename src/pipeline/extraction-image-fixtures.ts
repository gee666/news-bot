import type { ExtractionImage } from './extraction-evidence.js';
import type { ExtractedEvent } from './extraction-store.js';

export function extractionImage(id = 'i0'): ExtractionImage {
  return { image: { data: Buffer.from('fixture image').toString('base64'), mimeType: 'image/webp' }, provenance: {
    id, descriptor: { type: 'image', url: `https://example.org/${id}.png` },
    sourceSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64),
  } };
}
export function visualEvent(text = 'Acme released Compiler 2, available for $20 per month.',
  image = extractionImage()): ExtractedEvent {
  return { kind: 'image', parts: [], context: [], imageEvidence: [{ text, images: [image.provenance] }] };
}
