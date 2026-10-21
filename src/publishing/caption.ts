import { publicationSnapshotSchema } from '../types.js';
import { PublicationRenderError, renderValidatedSnapshot, type RenderedMessage } from './render.js';
import { orderSources } from './sources.js';

/** Bot API captions allow 1024 characters after entity parsing. UTF-16 counting is conservative for emoji. */
export const CAPTION_LIMIT = 1024;
const CAPTION_SOURCE_LIMIT = 3;

function shorten(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let result = text.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd();
  const boundary = result.lastIndexOf(' ');
  if (boundary > limit * 0.75) result = result.slice(0, boundary);
  return result + '…';
}

/** Keep the full snapshot in storage; only the Telegram presentation is shortened. */
export function renderCaption(content: unknown): RenderedMessage {
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  const snapshot = parsed.data;
  return renderValidatedSnapshot({ ...snapshot,
    headline: shorten(snapshot.headline, 140),
    sources: orderSources(snapshot.sources).slice(0, CAPTION_SOURCE_LIMIT).map(source => ({ ...source,
      label: shorten(source.label, 48),
    })),
    ...(snapshot.earlier ? { earlier: shorten(snapshot.earlier, 120) } : {}),
    ...(snapshot.review ? { review: { ...snapshot.review, reason: shorten(snapshot.review.reason.replace(/\s+/gu, ' ').trim(), 80) } } : {}),
  }, { limit: CAPTION_LIMIT, compactSources: false });
}
