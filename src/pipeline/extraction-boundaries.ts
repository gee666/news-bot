import { z } from 'zod';
import type { ValidationCode } from '../models/structured-diagnostics.js';
import { validSpans, eventSpans, type Span, type ExtractedEvent } from './extraction-store.js';

export interface SourceUnit extends Span { id: string; text: string }
export function sourceUnits(text: string): SourceUnit[] {
  const units: SourceUnit[] = [];
  const segmenter = new Intl.Segmenter('und', { granularity: 'sentence' });
  for (const line of text.matchAll(/[^\r\n]+/gu)) for (const sentence of segmenter.segment(line[0])) {
    const trimmed = sentence.segment.trim();
    if (!trimmed) continue;
    const start = line.index + sentence.index + sentence.segment.indexOf(trimmed);
    units.push({ id: `u${units.length}`, start, end: start + trimmed.length, text: trimmed });
  }
  return units;
}
function selectionSchemaWithIds(id: z.ZodType<string>) {
  const range = z.object({ first: id, last: id, excerpt: z.string().min(1).nullable() }).strict();
  return z.object({
    events: z.array(z.object({ parts: z.array(range).min(1), context: z.array(range) }).strict()),
    omitted: z.array(z.object({ id, last: id.nullable(), excerpt: z.string().min(1).nullable(),
      reason: z.enum(['heading', 'non_news', 'profile_excluded']) }).strict()),
  }).strict();
}
export const selectionSchema = selectionSchemaWithIds(z.string());
/** Known coordinates belong in the provider contract too; exact spans and coverage still need local checks. */
export function sourceSelectionSchema(units: readonly SourceUnit[]) {
  const ids = units.map(unit => unit.id);
  if (!ids.length) return selectionSchema.extend({ events: selectionSchema.shape.events.max(0), omitted: selectionSchema.shape.omitted.max(0) });
  // Native schemas cap enum entries. A finite literal pattern keeps large inputs lossless too.
  const id = ids.length <= 500 ? z.enum(ids)
    : z.string().regex(new RegExp(`^(?:${ids.map(value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})$`, 'u'));
  return selectionSchemaWithIds(id);
}
interface Range { first: string; last: string; excerpt?: string | null }
interface Omission { id: string; last?: string | null; excerpt?: string | null; reason: string }
export interface EventSelection {
  events: { parts: Range[]; context: Range[] }[];
  omitted: Omission[];
}
export function resolveRange(text: string, units: SourceUnit[], range: Range): Span | null {
  const first = units.findIndex(unit => unit.id === range.first);
  const last = units.findIndex(unit => unit.id === range.last);
  const start = units[first]?.start;
  const end = units[last]?.end;
  if (first < 0 || last < first || start === undefined || end === undefined) return null;
  if (range.excerpt == null) return { start, end };
  const source = text.slice(start, end);
  const offset = source.indexOf(range.excerpt);
  if (offset < 0 || source.indexOf(range.excerpt, offset + 1) >= 0) return null;
  return { start: start + offset, end: start + offset + range.excerpt.length };
}
function coverage(text: string, units: SourceUnit[], spans: Span[], omitted: Omission[]): boolean {
  const covered = [...spans];
  for (const omission of omitted) {
    const span = resolveRange(text, units, { first: omission.id, last: omission.last ?? omission.id, excerpt: omission.excerpt ?? null });
    if (!span) return false;
    covered.push(span);
  }
  covered.sort((a, b) => a.start - b.start);
  if (!validSpans(text, covered)) return false;
  for (const unit of units) {
    let cursor = unit.start;
    for (const span of covered) {
      if (span.end <= cursor || span.start >= unit.end) continue;
      if (span.start > cursor && /[^\p{P}\p{Z}\s]/u.test(text.slice(cursor, span.start))) return false;
      cursor = Math.min(unit.end, span.end);
    }
    if (/[^\p{P}\p{Z}\s]/u.test(text.slice(cursor, unit.end))) return false;
  }
  return true;
}
interface SelectionFailure { code: ValidationCode; feedback: string }
function selectionFailure(text: string, units: SourceUnit[], selection: EventSelection): SelectionFailure | null {
  if (selectedEvents(text, units, selection) !== null) return null;
  const assigned: { span: Span; label: string; kind: 'parts' | 'context' | 'omitted'; event: number }[] = [];
  for (const [eventIndex, event] of selection.events.entries()) for (const kind of ['parts', 'context'] as const) {
    for (const [index, range] of event[kind].entries()) {
      const span = resolveRange(text, units, range);
      if (span) assigned.push({ span, label: `events[${eventIndex}].${kind}[${index}] (${range.first}-${range.last})`, kind, event: eventIndex });
    }
  }
  for (const [index, omitted] of selection.omitted.entries()) {
    const span = resolveRange(text, units, { first: omitted.id, last: omitted.last ?? omitted.id, excerpt: omitted.excerpt ?? null });
    if (span) assigned.push({ span, label: `omitted[${index}] (${omitted.id}-${omitted.last ?? omitted.id})`, kind: 'omitted', event: -1 });
  }
  const overlaps: string[] = [];
  for (const [index, left] of assigned.entries()) {
    for (const right of assigned.slice(index + 1)) {
      if (left.kind === 'context' && right.kind === 'context' && left.event !== right.event) continue;
      if (left.span.start < right.span.end && right.span.start < left.span.end) overlaps.push(`${left.label} overlaps ${right.label}`);
      if (overlaps.length >= 8) break;
    }
    if (overlaps.length >= 8) break;
  }
  if (overlaps.length) return { code: 'extraction_overlap', feedback: `Conflicting assignments: ${overlaps.slice(0, 8).join('; ')}. A unit used as context must NOT also be omitted. Remove or narrow those omitted entries. Within one event merge overlapping ranges; between events only shared context may overlap. Keep all remaining words covered.` };
  const covered: Span[] = [];
  for (const range of [...selection.events.flatMap(event => [...event.parts, ...event.context]),
    ...selection.omitted.map(item => ({ first: item.id, last: item.last ?? item.id, excerpt: item.excerpt ?? null }))]) {
    const span = resolveRange(text, units, range);
    if (!span) return { code: 'extraction_anchor', feedback: `Invalid or non-unique source anchor: ${JSON.stringify(range)}. Copy the exact source spelling.` };
    covered.push(span);
  }
  covered.sort((a, b) => a.start - b.start);
  const missing: string[] = [];
  for (const unit of units) {
    let cursor = unit.start;
    for (const span of covered) {
      if (span.end <= cursor || span.start >= unit.end) continue;
      if (span.start > cursor && /[^\p{P}\p{Z}\s]/u.test(text.slice(cursor, span.start))) missing.push(`${unit.id}: ${JSON.stringify(text.slice(cursor, span.start))}`);
      cursor = Math.min(unit.end, span.end);
    }
    if (/[^\p{P}\p{Z}\s]/u.test(text.slice(cursor, unit.end))) missing.push(`${unit.id}: ${JSON.stringify(text.slice(cursor, unit.end))}`);
  }
  return missing.length ? { code: 'extraction_coverage', feedback: `Uncovered source text: ${missing.join('; ')}. Include conjunctions in an adjacent exact excerpt or explicitly omit them as non_news. Preserve all factual details.` }
    : { code: 'extraction_partition', feedback: 'Overlapping, reused primary parts or inconsistent context ranges. Only shared context may overlap between events.' };
}
export function selectionFeedback(text: string, units: SourceUnit[], selection: EventSelection): string {
  const failure = selectionFailure(text, units, selection);
  return failure?.feedback ?? (selection.events.length ? ''
    : 'Empty proposal. Review every omission against the whole source.');
}
export function selectionValidationCodes(text: string, units: SourceUnit[], selection: EventSelection): ValidationCode[] {
  const failure = selectionFailure(text, units, selection);
  return failure ? [failure.code] : [];
}
export function selectedEvents(text: string, units: SourceUnit[], selection: EventSelection): ExtractedEvent[] | null {
  const events: ExtractedEvent[] = [];
  const parts: Span[] = [];
  const contexts = new Map<string, Span>();
  for (const selected of selection.events) {
    const event: ExtractedEvent = { parts: [], context: [] };
    for (const kind of ['parts', 'context'] as const) for (const range of selected[kind]) {
      const span = resolveRange(text, units, range);
      if (!span) return null;
      event[kind].push(span);
      if (kind === 'parts') parts.push(span);
      else contexts.set(`${span.start}:${span.end}`, span);
    }
    if (!validSpans(text, eventSpans(event))) return null;
    events.push(event);
  }
  const mergedContext: Span[] = [];
  for (const span of [...contexts.values()].sort((a, b) => a.start - b.start)) {
    const previous = mergedContext.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else mergedContext.push({ ...span });
  }
  const all = [...parts, ...mergedContext].sort((a, b) => a.start - b.start);
  if (!validSpans(text, all) || !coverage(text, units, all, selection.omitted)) return null;
  return events;
}
