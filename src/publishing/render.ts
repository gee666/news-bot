import { publicationSnapshotSchema, type PublicationSnapshot, type PublicationSource } from '../types.js';
import { visibleSources, SOURCE_GROUPS, sourceGroup } from './sources.js';
import { LIST_MARKER, normalizeMarkedLists, presentationSourceLabel } from './presentation.js';

export interface SourceLink { offset: number; length: number; url: string }
export interface RenderedMessage {
  text: string;
  plainText: string;
  links: SourceLink[];
  parse_mode: 'HTML';
  link_preview_options: { is_disabled: true };
  reply_markup: { inline_keyboard: [] };
}
export const publicationRenderCodes = ['publication_snapshot_invalid', 'publication_entity_limit',
  'publication_message_too_long'] as const;
export type PublicationRenderCode = typeof publicationRenderCodes[number];
export class PublicationRenderError extends Error {
  constructor(readonly code: PublicationRenderCode) { super(code); }
}
export const MESSAGE_LIMIT = 4096;
// Maximum sources while reserving one entity for each of the two possible headings.
export const SOURCE_LIMIT = 98;
export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function status(source: PublicationSource): string {
  return [source.classification === 'uncertain' ? 'связь с новостью неясна' : '',
    source.access === 'restricted' ? 'доступ ограничен' : source.access === 'unavailable' ? 'недоступно' : ''].filter(Boolean).join(', ');
}
function sourceEntityCount(snapshot: PublicationSnapshot): number {
  const visible = visibleSources(snapshot.sources).filter(source => !source.unverifiedPublication);
  return 1 + visible.length + new Set(visible.map(sourceGroup)).size;
}
function sourceSections(snapshot: PublicationSnapshot, compact: boolean): { text: string; plainText: string; links: SourceLink[] } {
  let text = ''; let plainText = ''; let number = 0;
  const links: SourceLink[] = [];
  const orderedSources = visibleSources(snapshot.sources);
  for (const group of SOURCE_GROUPS) {
    const sources = orderedSources.filter(source => sourceGroup(source) === group.kind);
    if (!sources.length) continue;
    text += `\n\n<b>${group.heading}</b>\n`;
    plainText += `\n\n${group.heading}\n`;
    for (const [index, source] of sources.entries()) {
      number++;
      if (index) { text += '\n'; plainText += '\n'; }
      const host = new URL(source.url).hostname.replace(/^www\./u, '');
      const label = (snapshot.presentationVersion === 1 ? presentationSourceLabel(source)
        : compact ? `${number}. ${host}` : source.label) + (status(source) ? ` · ${status(source)}` : '');
      if (snapshot.presentationVersion === 1) { text += LIST_MARKER; plainText += LIST_MARKER; }
      links.push({ offset: plainText.length, length: label.length, url: source.url });
      text += `<a href="${escapeHtml(source.url)}">${escapeHtml(label)}</a>`;
      plainText += label;
    }
  }
  return { text, plainText, links };
}
function stripTrailingCitationMarkers(text: string): string {
  return text.replace(/\s+\[\d+(?:\s*,\s*\d+)*\](?=\s*(?:\n\s*\n|$))/gu, '');
}
function interestBar(score: number): string {
  return '•'.repeat(score) + '◦'.repeat(10 - score);
}
function header(snapshot: PublicationSnapshot, headline: string): string {
  return `${interestBar(snapshot.score)}\n${headline}`;
}
function reviewNotes(snapshot: PublicationSnapshot): string {
  const reason = snapshot.review?.reason.replace(/\s+/gu, ' ').trim().slice(0, 240);
  return reason ? `\n\nЗаметки проверяющего: ${reason}` : '';
}

export interface RenderOptions { limit?: number; compactSources?: boolean }

export function render(content: unknown, options: RenderOptions = {}): RenderedMessage {
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  const snapshot = parsed.data;
  const markerOptions = { presentationVersion: snapshot.presentationVersion, headline: snapshot.updatedToHeadline };
  const limit = options.limit ?? MESSAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGE_LIMIT) throw new RangeError('Invalid publication text limit');
  const prefixLength = snapshot.updatedTo ? updateMarkerPrefix(snapshot.updatedTo, markerOptions).plainText.length : 0;
  if (prefixLength >= limit) throw new PublicationRenderError('publication_message_too_long');
  const message = renderValidatedSnapshot(snapshot, { ...options, limit: limit - prefixLength });
  return snapshot.updatedTo ? withUpdateMarker(message, snapshot.updatedTo, limit, markerOptions) : message;
}

function renderValidatedSnapshot(snapshot: PublicationSnapshot, options: RenderOptions = {}): RenderedMessage {
  const limit = options.limit ?? MESSAGE_LIMIT;
  if (sourceEntityCount(snapshot) + Number(Boolean(snapshot.updatedTo)) > 100) throw new PublicationRenderError('publication_entity_limit');
  const headline = stripTrailingCitationMarkers(snapshot.headline).slice(0, 180);
  const notes = reviewNotes(snapshot);
  const bodyPresentation = snapshot.presentationVersion === 1 ? normalizeMarkedLists : (text: string) => text;
  const details = bodyPresentation(stripTrailingCitationMarkers(snapshot.details ?? ''));
  const earlier = bodyPresentation(stripTrailingCitationMarkers(snapshot.earlier ?? ''));
  const bodyText = () => header(snapshot, headline) + (details ? `\n\n${details}` : '')
    + (earlier ? `\n\n${earlier}` : '') + notes;
  const body = bodyText();
  let sections = sourceSections(snapshot, false);
  if ((body + sections.plainText).length > limit && options.compactSources !== false)
    sections = sourceSections(snapshot, true);

  const plainText = body + sections.plainText;
  if (plainText.length > limit) throw new PublicationRenderError('publication_message_too_long');
  let text = `${interestBar(snapshot.score)}\n<b>${escapeHtml(headline)}</b>`;
  if (details) text += `\n\n${escapeHtml(details)}`;
  if (earlier) text += `\n\n${escapeHtml(earlier)}`;
  text += escapeHtml(notes) + sections.text;
  const links = sections.links.map(link => ({ ...link, offset: body.length + link.offset }));
  return { text, plainText, links, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } };
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

/** Existing albums have a caption limit; every other canonical post is text. */
export function renderPublication(publication: { content: unknown; delivery_kind?: 'text' | 'album' | 'media_first' }): RenderedMessage {
  return render(publication.content, { limit: publication.delivery_kind === 'album' ? 1024 : MESSAGE_LIMIT });
}
