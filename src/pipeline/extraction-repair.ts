import { resolveRange, selectedEvents, type EventSelection, type SourceUnit } from './extraction-boundaries.js';
import type { ExtractedEvent, Span } from './extraction-store.js';

/** Unions only already-selected overlapping words. Never fills a gap or joins different events. */
function merge(spans: Span[]): Span[] {
  const result: Span[] = [];
  for (const span of [...spans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    const previous = result.at(-1);
    if (previous && span.start < previous.end) previous.end = Math.max(previous.end, span.end);
    else result.push({ ...span });
  }
  return result;
}
function subtract(span: Span, assigned: Span[]): Span[] {
  let remaining = [{ ...span }];
  for (const used of assigned) remaining = remaining.flatMap(part => {
    if (used.end <= part.start || used.start >= part.end) return [part];
    return [...(used.start > part.start ? [{ start: part.start, end: used.start }] : []),
      ...(used.end < part.end ? [{ start: used.end, end: part.end }] : [])];
  });
  return remaining;
}
function anchor(text: string, units: SourceUnit[], span: Span) {
  const first = units.find(unit => unit.start <= span.start && unit.end > span.start);
  const last = units.find(unit => unit.start < span.end && unit.end >= span.end);
  if (!first || !last) return null;
  const range = { first: first.id, last: last.id,
    excerpt: span.start === first.start && span.end === last.end ? null : text.slice(span.start, span.end) };
  const resolved = resolveRange(text, units, range);
  return resolved?.start === span.start && resolved.end === span.end ? range : null;
}

/**
 * Repair redundant coordinates, not semantic boundaries. Acceptance still needs independent
 * candidate eligibility and one-event validation. Conflicting event/exclusion ownership stays invalid.
 */
export function repairExtractionOverlap(text: string, units: SourceUnit[], selection: EventSelection): ExtractedEvent[] | null {
  if (selectedEvents(text, units, selection) !== null || !selection.events.length) return null;
  const normalized: EventSelection = { events: [], omitted: [] };
  const contexts: Span[] = [];
  for (const event of selection.events) {
    const parts = event.parts.map(range => resolveRange(text, units, range));
    const context = event.context.map(range => resolveRange(text, units, range));
    if (parts.some(span => span === null) || context.some(span => span === null)) return null;
    const mergedParts = merge(parts.filter((span): span is Span => span !== null));
    const mergedContext = merge(context.filter((span): span is Span => span !== null))
      .flatMap(span => subtract(span, mergedParts));
    const partRanges = mergedParts.map(span => anchor(text, units, span));
    const contextRanges = mergedContext.map(span => anchor(text, units, span));
    if (partRanges.some(range => range === null) || contextRanges.some(range => range === null)) return null;
    normalized.events.push({ parts: partRanges.filter(range => range !== null), context: contextRanges.filter(range => range !== null) });
    contexts.push(...mergedContext);
  }
  for (const omitted of selection.omitted) {
    const span = resolveRange(text, units, { first: omitted.id, last: omitted.last ?? omitted.id, excerpt: omitted.excerpt ?? null });
    if (!span) return null;
    // Context is not an independent news event, so a short heading/non-news omission can be
    // redundant. Never override profile exclusions or any omitted primary event facts.
    const redundantContext = (omitted.reason === 'heading' || omitted.reason === 'non_news') && span.end - span.start <= 300;
    const spans = redundantContext ? subtract(span, contexts) : [span];
    for (const remaining of spans) {
      if (!text.slice(remaining.start, remaining.end).trim()) continue;
      const range = anchor(text, units, remaining);
      if (!range) return null;
      normalized.omitted.push({ id: range.first, last: range.last, excerpt: range.excerpt, reason: omitted.reason });
    }
  }
  // This final strict check rejects cross-event parts, unknown/ambiguous anchors, newly uncovered
  // words, and context that steals another event's facts. The caller never commits a partial repair.
  return selectedEvents(text, units, normalized);
}
