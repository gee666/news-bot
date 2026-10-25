import { z } from 'zod';
import { publicationSnapshotSchema, type PublicationSource } from '../types.js';
import { escapeHtml, MESSAGE_LIMIT, PublicationRenderError, type RenderedMessage } from './render.js';
import { visibleSources, SOURCE_GROUPS, sourceGroup } from './sources.js';
import { LIST_MARKER, normalizeMarkedLists, presentationSourceLabel } from './presentation.js';

// Frozen unversioned plans retain the original reserved budget and fingerprints.
const LEGACY_FIRST_MESSAGE_LIMIT = MESSAGE_LIMIT - 128;
const ENTITY_LIMIT = 90;
export const renderedMessageSchema = z.object({
  text: z.string(), plainText: z.string(),
  links: z.array(z.object({ offset: z.number().int().nonnegative(), length: z.number().int().positive(), url: z.url() })),
  parse_mode: z.literal('HTML'), link_preview_options: z.object({ is_disabled: z.literal(true) }),
  reply_markup: z.object({ inline_keyboard: z.tuple([]) }),
});
function emptyMessage(): RenderedMessage {
  return { text: '', plainText: '', links: [], parse_mode: 'HTML',
    link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } };
}
function sourceLabel(source: PublicationSource, version?: 1): string {
  const status = [source.classification === 'uncertain' ? 'связь с новостью неясна' : '',
    source.access === 'restricted' ? 'доступ ограничен' : source.access === 'unavailable' ? 'недоступно' : ''].filter(Boolean);
  return (version === 1 ? presentationSourceLabel(source) : source.label) + (status.length ? ` · ${status.join(', ')}` : '');
}

/** Split decoded text, never raw HTML. Every source and every UTF-16 character survives. */
export function renderFullText(content: unknown, sourcesOnly = false, firstLimit?: number): RenderedMessage[] {
  if (firstLimit !== undefined && (!Number.isInteger(firstLimit) || firstLimit < 2 || firstLimit > MESSAGE_LIMIT))
    throw new PublicationRenderError('publication_message_too_long');
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  const snapshot = parsed.data;
  // Legacy default plans must remain byte-for-byte reproducible. Version 1 reserves only an actual prefix.
  const markerOptions = { presentationVersion: snapshot.presentationVersion, headline: snapshot.updatedToHeadline };
  const markerLength = snapshot.updatedTo ? updateMarkerPrefix(snapshot.updatedTo, markerOptions).plainText.length : 0;
  const firstBodyLimit = firstLimit !== undefined ? firstLimit - markerLength
    : snapshot.presentationVersion === 1 ? MESSAGE_LIMIT - markerLength : LEGACY_FIRST_MESSAGE_LIMIT;
  if (firstBodyLimit < 2) throw new PublicationRenderError('publication_message_too_long');
  const messages: RenderedMessage[] = [];
  let message = emptyMessage();
  let entities = 0;
  const flush = () => { if (message.plainText) messages.push(message); message = emptyMessage(); entities = 0; };
  const append = (value: string, kind?: 'bold' | 'link', url?: string) => {
    let remaining = value;
    while (remaining) {
      const limit = messages.length ? MESSAGE_LIMIT : firstBodyLimit;
      const room = limit - message.plainText.length;
      if (!room || kind && entities >= ENTITY_LIMIT) { flush(); continue; }
      let length = Math.min(remaining.length, room);
      if (length < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[length - 1] ?? '')) length--;
      if (!length) { flush(); continue; }
      const piece = remaining.slice(0, length);
      const html = escapeHtml(piece);
      if (kind === 'link' && url) {
        message.links.push({ offset: message.plainText.length, length: piece.length, url });
        message.text += `<a href="${escapeHtml(url)}">${html}</a>`;
      } else message.text += kind === 'bold' ? `<b>${html}</b>` : html;
      message.plainText += piece;
      if (kind) entities++;
      remaining = remaining.slice(length);
    }
  };
  const appendSource = (source: PublicationSource) => {
    let remaining = sourceLabel(source, snapshot.presentationVersion);
    if (snapshot.presentationVersion !== 1) { append('\n'); append(remaining, 'link', source.url); return; }
    while (remaining) {
      const prefix = '\n' + LIST_MARKER;
      const room = (messages.length ? MESSAGE_LIMIT : firstBodyLimit) - message.plainText.length - prefix.length;
      let length = Math.min(remaining.length, Math.max(0, room));
      if (length < remaining.length && /[\uD800-\uDBFF]/u.test(remaining[length - 1] ?? '')) length--;
      // Keep the marker and at least one complete label character in the same part.
      if (!length || entities >= ENTITY_LIMIT) { flush(); continue; }
      append(prefix);
      append(remaining.slice(0, length), 'link', source.url);
      remaining = remaining.slice(length);
    }
  };
  if (!sourcesOnly) {
  append('•'.repeat(snapshot.score) + '◦'.repeat(10 - snapshot.score) + '\n');
  append(snapshot.headline, 'bold');
  const bodyPresentation = snapshot.presentationVersion === 1 ? normalizeMarkedLists : (text: string) => text;
  if (snapshot.details) append('\n\n' + bodyPresentation(snapshot.details));
  if (snapshot.earlier) append('\n\n' + bodyPresentation(snapshot.earlier));
  if (snapshot.review?.reason.trim()) append('\n\nЗаметки проверяющего: ' + snapshot.review.reason);
  }
  const sources = visibleSources(snapshot.sources);
  for (const group of SOURCE_GROUPS) {
    const selected = sources.filter(source => sourceGroup(source) === group.kind);
    if (!selected.length) continue;
    const room=(messages.length ? MESSAGE_LIMIT : firstBodyLimit)-message.plainText.length;
    if (message.plainText && room<group.heading.length+2) flush();
    append('\n\n'); append(group.heading, 'bold');
    for (const source of selected) appendSource(source);
  }
  flush();
  if (sourcesOnly && snapshot.updatedTo && !messages.length) messages.push(emptyMessage());
  if (snapshot.updatedTo && messages[0]) messages[0] = withUpdateMarker(messages[0], snapshot.updatedTo, firstLimit ?? MESSAGE_LIMIT, markerOptions);
  return messages;
}

export interface UpdateMarkerOptions { presentationVersion?: 1 | undefined; headline?: string | undefined }

export function updateMarkerPrefix(url: string, options: UpdateMarkerOptions = {}): Pick<RenderedMessage, 'text' | 'plainText' | 'links'> {
  const versioned = options.presentationVersion === 1;
  const post = versioned ? new URL(url).pathname.split('/').filter(Boolean).at(-1) : undefined;
  const headline = options.headline?.replace(/\s+/gu, ' ').trim();
  const label = versioned ? `#${post}` + (headline ? ` · ${headline}` : '') : url;
  const lead = versioned ? `UPD:\n${LIST_MARKER}` : 'UPD: ';
  return { text: `${lead}<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>\n\n`,
    plainText: `${lead}${label}\n\n`, links: [{ offset: lead.length, length: label.length, url }] };
}

export function withUpdateMarker(message: RenderedMessage, url: string, limit = MESSAGE_LIMIT,
  options: UpdateMarkerOptions = {}): RenderedMessage {
  const prefix = updateMarkerPrefix(url, options);
  if (prefix.plainText.length + message.plainText.length > limit) throw new PublicationRenderError('publication_message_too_long');
  return { ...message, text: prefix.text + message.text, plainText: prefix.plainText + message.plainText,
    links: [...prefix.links, ...message.links.map(link => ({ ...link, offset: link.offset + prefix.plainText.length }))] };
}
