import { z } from 'zod';

/** Raw base64 bytes, not a data URL. Attachment order is significant. */
export interface ModelImage { data: string; mimeType: string }

export const modelImageSchema = z.object({
  data: z.string().min(1).refine(data => data.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data),
  'Expected base64 image bytes'),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
});
export const modelImagesSchema = z.array(modelImageSchema);
