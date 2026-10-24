import { z } from 'zod';
import { publicationSnapshotSchema, type PublicationSource } from '../types.js';
import { escapeHtml, MESSAGE_LIMIT, PublicationRenderError, type RenderedMessage } from './render.js';
import { orderSources, SOURCE_GROUPS, sourceGroup } from './sources.js';

// Leave room to prepend an UPD link later without changing any original text.
const FIRST_MESSAGE_LIMIT = MESSAGE_LIMIT - 128;
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
function sourceLabel(source: PublicationSource): string {
  const status = [source.classification === 'uncertain' ? 'связь с новостью неясна' : '',
    source.access === 'restricted' ? 'доступ ограничен' : source.access === 'unavailable' ? 'недоступно' : ''].filter(Boolean);
  return source.label + (status.length ? ` · ${status.join(', ')}` : '');
}

/** Split decoded text, never raw HTML. Every source and every UTF-16 character survives. */
export function renderFullText(content: unknown): RenderedMessage[] {
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  const snapshot = parsed.data;
  const messages: RenderedMessage[] = [];
  let message = emptyMessage();
  let entities = 0;
  const flush = () => { if (message.plainText) messages.push(message); message = emptyMessage(); entities = 0; };
  const append = (value: string, kind?: 'bold' | 'link', url?: string) => {
    let remaining = value;
    while (remaining) {
      const limit = messages.length ? MESSAGE_LIMIT : FIRST_MESSAGE_LIMIT;
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
  append('•'.repeat(snapshot.score) + '◦'.repeat(10 - snapshot.score) + '\n');
  append(snapshot.headline, 'bold');
  if (snapshot.earlier) {
    append('\n\n'); append('Новое', 'bold'); append('\n' + snapshot.details);
    append('\n\n'); append('Ранее было опубликовано', 'bold'); append('\n' + snapshot.earlier);
  } else if (snapshot.details) append('\n\n' + snapshot.details);
  if (snapshot.review?.reason.trim()) append('\n\nЗаметки проверяющего: ' + snapshot.review.reason);
  const sources = orderSources(snapshot.sources);
  for (const group of SOURCE_GROUPS) {
    const selected = sources.filter(source => sourceGroup(source) === group.kind);
    if (!selected.length) continue;
    append('\n\n'); append(group.heading, 'bold');
    for (const source of selected) { append('\n'); append(sourceLabel(source), 'link', source.url); }
  }
  flush();
  if (snapshot.updatedTo && messages[0]) messages[0] = withUpdateMarker(messages[0], snapshot.updatedTo);
  return messages;
}

export function withUpdateMarker(message: RenderedMessage, url: string, limit = MESSAGE_LIMIT): RenderedMessage {
  const prefix = `UPD: ${url}\n\n`;
  if (prefix.length + message.plainText.length > limit) throw new PublicationRenderError('publication_message_too_long');
  return { ...message, text: `UPD: <a href="${escapeHtml(url)}">${escapeHtml(url)}</a>\n\n${message.text}`,
    plainText: prefix + message.plainText,
    links: [{ offset: 5, length: url.length, url }, ...message.links.map(link => ({ ...link, offset: link.offset + prefix.length }))] };
}
