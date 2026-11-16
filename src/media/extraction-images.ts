import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExtractionImage } from '../pipeline/extraction-evidence.js';
import { requireInferenceApproval } from '../pipeline/generation-model.js';
import { envInteger } from '../pipeline/research-fetch.js';
import { compressModelImage } from './codec.js';
import { abortable, MediaDeadline } from './deadline.js';
import { downloadMedia, mediaDescriptor } from './download.js';
import { distinctSourceMedia } from './source-images.js';

export interface ExtractionMediaSource {
  metadata: Record<string, unknown>;
  source_metadata: Record<string, unknown>;
  access: string;
}
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Unlike optional publication media, unresolved extraction inputs must fail the stage. */
export async function extractionImages(source: ExtractionMediaSource, operationId: string,
  signal?: AbortSignal): Promise<ExtractionImage[]> {
  await requireInferenceApproval([source.access], operationId);
  const descriptors = distinctSourceMedia(z.array(mediaDescriptor).parse(source.metadata.media ?? []))
    .filter(descriptor => descriptor.type === 'image');
  const seen = new Set<string>();
  const images = descriptors.filter(descriptor => {
    const key = JSON.stringify(descriptor);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (!images.length) return [];
  const limit = envInteger('MEDIA_EXTRACTION_MAX_IMAGES', 10, 10);
  if (images.length > limit) throw new Error('Extraction image count exceeds limit; input was not truncated');
  const maxBytes = envInteger('MEDIA_EXTRACTION_MAX_BYTES', 45_000_000, 90_000_000);
  const deadline = new MediaDeadline();
  const inputSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  try {
    return await abortable(inputSignal, async () => {
      const prepared: ExtractionImage[] = [];
      let sourceBytes = 0;
      let modelBytes = 0;
      for (const [index, descriptor] of images.entries()) {
        inputSignal.throwIfAborted();
        const media = await abortable(inputSignal, () => downloadMedia(descriptor, { metadata: source.source_metadata }, inputSignal));
        inputSignal.throwIfAborted();
        sourceBytes += media.data.length;
        if (media.type !== 'image' || !media.data.length || media.data.length > 9_000_000 || sourceBytes > maxBytes) {
          throw new Error('Extraction image download exceeds limit or is invalid');
        }
        const data = await abortable(inputSignal, () => compressModelImage(media.data, { signal: inputSignal, maxOutputBytes: 9_000_000 }));
        inputSignal.throwIfAborted();
        modelBytes += data.length;
        if (!data.length || modelBytes > maxBytes) throw new Error('Extraction model image bytes exceed limit or are empty');
        prepared.push({ image: { data: data.toString('base64'), mimeType: 'image/webp' }, provenance: {
          id: `i${index}`, descriptor: { ...descriptor, type: 'image' }, sourceSha256: sha256(media.data), modelSha256: sha256(data),
        } });
      }
      return prepared;
    });
  } catch (error) {
    deadline.abort();
    throw error;
  } finally { deadline.dispose(); }
}
