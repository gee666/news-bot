import { publicationSnapshotSchema, type PublicationSnapshot, type PublicationSource } from '../types.js';
import { orderSources, SOURCE_GROUPS, sourceGroup } from './sources.js';

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
  'publication_message_too_long', 'publication_sources_unresolved', 'publication_no_details_budget'] as const;
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
  return 1 + snapshot.sources.length + new Set(snapshot.sources.map(sourceGroup)).size;
}
function sourceSections(snapshot: PublicationSnapshot, compact: boolean): { text: string; plainText: string; links: SourceLink[] } {
  let text = ''; let plainText = ''; let number = 0;
  const links: SourceLink[] = [];
  const orderedSources = orderSources(snapshot.sources);
  for (const group of SOURCE_GROUPS) {
    const sources = orderedSources.filter(source => sourceGroup(source) === group.kind);
    if (!sources.length) continue;
    text += `\n\n<b>${group.heading}</b>\n`;
    plainText += `\n\n${group.heading}\n`;
    for (const [index, source] of sources.entries()) {
      number++;
      if (index) { text += '\n'; plainText += '\n'; }
      const host = new URL(source.url).hostname.replace(/^www\./u, '');
      const label = (compact ? `${number}. ${host}` : source.label) + (status(source) ? ` · ${status(source)}` : '');
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

/** Telegram's visible-text budget, including reviewer notes and source links. */
export function publicationDetailsBudget(content: unknown): number {
  const snapshot = publicationSnapshotSchema.parse(content);
  if (sourceEntityCount(snapshot) > 100) return 0;
  const headline = stripTrailingCitationMarkers(snapshot.headline);
  return Math.max(0, MESSAGE_LIMIT - header(snapshot, headline).length - 2
    - reviewNotes(snapshot).length - sourceSections(snapshot, true).plainText.length);
}
export function render(content: unknown): RenderedMessage {
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  const snapshot = parsed.data;
  if (sourceEntityCount(snapshot) > 100) throw new PublicationRenderError('publication_entity_limit');
  const headline = stripTrailingCitationMarkers(snapshot.headline).slice(0, 180);
  const notes = reviewNotes(snapshot);
  let details = stripTrailingCitationMarkers(snapshot.details ?? '');
  let body = header(snapshot, headline) + (details ? `\n\n${details}` : '') + notes;
  let sections = sourceSections(snapshot, false);
  if ((body + sections.plainText).length > MESSAGE_LIMIT) {
    sections = sourceSections(snapshot, true);
    const budget = Math.max(0, MESSAGE_LIMIT - header(snapshot, headline).length - 2 - notes.length - sections.plainText.length);
    if (details.length > budget) {
      details = details.slice(0, Math.max(0, budget - 1)).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + (budget ? '…' : '');
      body = header(snapshot, headline) + (details ? `\n\n${details}` : '') + notes;
    }
  }
  const plainText = body + sections.plainText;
  if (plainText.length > MESSAGE_LIMIT) throw new PublicationRenderError('publication_message_too_long');
  let text = `${interestBar(snapshot.score)}\n<b>${escapeHtml(headline)}</b>`;
  if (details) text += `\n\n${escapeHtml(details)}`;
  text += escapeHtml(notes) + sections.text;
  const links = sections.links.map(link => ({ ...link, offset: body.length + link.offset }));
  return { text, plainText, links, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } };
}
