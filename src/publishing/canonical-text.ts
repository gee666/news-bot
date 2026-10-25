import { publicationSnapshotSchema } from '../types.js';
import { renderFullText } from './full-text.js';
import { MESSAGE_LIMIT, PublicationRenderError, type RenderedMessage } from './render.js';
import { visibleSources } from './sources.js';

/** A publication is one text or caption. Never move body text or links into follow-ups. */
export function renderCanonicalText(content: unknown, limit = MESSAGE_LIMIT): RenderedMessage {
  const parts = renderFullText(content, false, limit);
  const first = parts[0];
  if (!first || parts.length !== 1) {
    const length = parts.reduce((total, part) => total + part.plainText.length, 0);
    throw new PublicationRenderError(length > limit ? 'publication_message_too_long' : 'publication_entity_limit');
  }
  assertCanonicalLinks(content, first, limit);
  return first;
}

/** Also check frozen plans: a first-part fingerprint alone does not prove link completeness. */
export function assertCanonicalLinks(content: unknown, message: RenderedMessage, limit = MESSAGE_LIMIT): void {
  const snapshot = publicationSnapshotSchema.safeParse(content);
  if (!snapshot.success) throw new PublicationRenderError('publication_snapshot_invalid');
  if (message.plainText.length > limit) throw new PublicationRenderError('publication_message_too_long');
  if (message.links.length + (message.text.match(/<b>/gu)?.length ?? 0) > 98)
    throw new PublicationRenderError('publication_entity_limit');
  const urls = new Set(message.links.map(link => link.url));
  const visible = visibleSources(snapshot.data.sources);
  const visibleUrls = new Set(visible.map(source => source.url));
  const hiddenRelated = snapshot.data.sources.filter(source => source.relatedPublication && !visibleUrls.has(source.url));
  if (hiddenRelated.some(source => urls.has(source.url))
    || visible.some(source => !source.unverifiedPublication && !urls.has(source.url))
    || snapshot.data.updatedTo && !urls.has(snapshot.data.updatedTo))
    throw new PublicationRenderError('publication_text_requires_new_edition');
}
