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
  'publication_message_too_long', 'publication_text_requires_new_edition', 'publication_sources_unresolved', 'publication_no_details_budget'] as const;
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

export interface RenderOptions { limit?: number; compactSources?: boolean; legacyBudget?: boolean }

export function render(content: unknown, options: RenderOptions = {}): RenderedMessage {
  const parsed = publicationSnapshotSchema.safeParse(content);
  if (!parsed.success) throw new PublicationRenderError('publication_snapshot_invalid');
  return renderValidatedSnapshot(parsed.data, options);
}

/** Presentation shortening need not preserve editorial schema rules, such as a Cyrillic review reason. */
export function renderValidatedSnapshot(snapshot: PublicationSnapshot, options: RenderOptions = {}): RenderedMessage {
  const limit = options.limit ?? MESSAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MESSAGE_LIMIT) throw new RangeError('Invalid publication text limit');
  if (sourceEntityCount(snapshot) > 100) throw new PublicationRenderError('publication_entity_limit');
  const headline = stripTrailingCitationMarkers(snapshot.headline).slice(0, 180);
  const notes = reviewNotes(snapshot);
  let details = stripTrailingCitationMarkers(snapshot.details ?? '');
  let earlier = stripTrailingCitationMarkers(snapshot.earlier ?? '');
  const bodyText = () => header(snapshot, headline) + (details ? `\n\n${details}` : '')
    + (earlier ? `\n\n${earlier}` : '') + notes;
  // Reconstruct the old trimming budget when freezing a pre-parts publication.
  // The obsolete labels are never emitted.
  const legacyBudget = options.legacyBudget && snapshot.earlier ? 'Новое\nРанее было опубликовано\n'.length : 0;
  let body = bodyText();
  let sections = sourceSections(snapshot, false);
  if ((body + sections.plainText).length + legacyBudget > limit) {
    if (options.compactSources !== false) sections = sourceSections(snapshot, true);
    const trim = (text: string, budget: number) => text.slice(0, Math.max(0, budget - 1))
      .replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + (budget > 0 ? '…' : '');
    const overflow = () => Math.max(0, bodyText().length + sections.plainText.length + legacyBudget - limit);
    if (overflow() && earlier) earlier = trim(earlier, Math.max(0, earlier.length - overflow()));
    if (overflow() && details) details = trim(details, Math.max(0, details.length - overflow()));
    body = bodyText();
  }

  const plainText = body + sections.plainText;
  if (plainText.length > limit) throw new PublicationRenderError('publication_message_too_long');
  let text = `${interestBar(snapshot.score)}\n<b>${escapeHtml(headline)}</b>`;
  if (details) text += `\n\n${escapeHtml(details)}`;
  if (earlier) text += `\n\n${escapeHtml(earlier)}`;
  text += escapeHtml(notes) + sections.text;
  const links = sections.links.map(link => ({ ...link, offset: body.length + link.offset }));
  return { text, plainText, links, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [] } };
}
