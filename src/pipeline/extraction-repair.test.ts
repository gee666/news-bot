import { expect, it } from 'vitest';
import { repairExtractionOverlap } from './extraction-repair.js';
import { selectedEvents, selectionValidationCodes, sourceUnits, type EventSelection } from './extraction-boundaries.js';
import { eventText } from './extraction-store.js';

const range = (first: string, last = first, excerpt: string | null = null) => ({ first, last, excerpt });
const text = 'At Acme developer day in Oslo.\nAcme released Assistant X.\nBeta updated Editor Y.';
function sharedHeading(): EventSelection {
  return { events: [
    { parts: [range('u1')], context: [range('u0')] },
    { parts: [range('u2')], context: [range('u0')] },
  ], omitted: [{ id: 'u0', last: null, excerpt: null, reason: 'heading' }] };
}
it.each(['heading', 'non_news'])('removes a redundant short %s omission without changing shared context or event ownership', reason => {
  const selection = sharedHeading(); selection.omitted[0]!.reason = reason;
  const original = structuredClone(selection);
  const units = sourceUnits(text);
  expect(selectionValidationCodes(text, units, selection)).toEqual(['extraction_overlap']);
  const events = repairExtractionOverlap(text, units, selection);
  expect(events?.map(event => eventText(text, event))).toEqual([
    'At Acme developer day in Oslo.\n\nAcme released Assistant X.',
    'At Acme developer day in Oslo.\n\nBeta updated Editor Y.',
  ]);
  expect(events?.[0]?.context).toEqual(events?.[1]?.context);
  expect(selection).toEqual(original);
});
it('unions overlapping parts only within their original event, retaining all details and exclusions', () => {
  const source = 'Acme released Assistant X.\nIt has memory.\nIt costs $20 per month.\nBuy an unrelated course.';
  const selection: EventSelection = { events: [{ parts: [range('u0', 'u1'), range('u1', 'u2')], context: [] }],
    omitted: [{ id: 'u3', last: null, excerpt: null, reason: 'profile_excluded' }] };
  const events = repairExtractionOverlap(source, sourceUnits(source), selection);
  expect(events?.map(event => eventText(source, event))).toEqual([
    'Acme released Assistant X.\nIt has memory.\nIt costs $20 per month.',
  ]);
  expect(events?.[0]?.parts).toEqual([{ start: 0, end: source.indexOf('\nBuy') }]);
});
it('does not fill gaps or merge unrelated events when repairing duplicated nonadjacent release parts', () => {
  const source = 'Acme released Assistant X.\nBeta updated Editor Y.\nAssistant X is free.';
  const selection = { events: [
    { parts: [range('u0'), range('u0'), range('u2')], context: [] },
    { parts: [range('u1')], context: [] },
  ], omitted: [] };
  const events = repairExtractionOverlap(source, sourceUnits(source), selection);
  expect(events?.map(event => eventText(source, event))).toEqual([
    'Acme released Assistant X.\n\nAssistant X is free.', 'Beta updated Editor Y.',
  ]);
  expect(events?.[0]?.parts).toHaveLength(2);
});
it('deduplicates context and removes only the part already owned by that same event', () => {
  const source = 'Rumor: Acme may launch tomorrow.\nAvailability is not confirmed.';
  const selection = { events: [{ parts: [range('u0', 'u1')], context: [range('u0'), range('u0')] }], omitted: [] };
  expect(repairExtractionOverlap(source, sourceUnits(source), selection)).toEqual([
    { parts: [{ start: 0, end: source.length }], context: [] },
  ]);
});
it('preserves exact Unicode/CRLF coordinates during duplicate range repair', () => {
  const source = '\t🚀 Компания выпустила\u00a0модель.\r\nЦена: 20 €.';
  const selection = { events: [{ parts: [range('u0', 'u1'), range('u1')], context: [] }], omitted: [] };
  const events = repairExtractionOverlap(source, sourceUnits(source), selection);
  expect(events).toEqual([{ parts: [{ start: 1, end: source.length }], context: [] }]);
  expect(eventText(source, events![0]!)).toBe(source.slice(1));
});
it('does not override a profile-excluded context block', () => {
  const reason = 'profile_excluded';
  const selection = sharedHeading(); selection.omitted[0]!.reason = reason;
  expect(repairExtractionOverlap(text, sourceUnits(text), selection)).toBeNull();
});
it.each(['heading', 'non_news', 'profile_excluded'])('does not override %s exclusions of primary event parts', reason => {
  const selection: EventSelection = { events: [{ parts: [range('u0', 'u2')], context: [] }],
    omitted: [{ id: 'u1', last: null, excerpt: null, reason }] };
  expect(repairExtractionOverlap(text, sourceUnits(text), selection)).toBeNull();
});
it('does not absorb a long course/tutorial block as a supposedly omitted heading', () => {
  const source = 'Buy our course.\n' + 'Tutorial instructions. '.repeat(30) + '\nAcme released Compiler 2.';
  const units = sourceUnits(source);
  const news = units.at(-1)?.id;
  const course = units.at(-2)?.id;
  if (!news || !course) throw new Error('Missing source units');
  const selection: EventSelection = { events: [{ parts: [range(news)], context: [range('u0', course)] }],
    omitted: [{ id: 'u0', last: course, excerpt: null, reason: 'heading' }] };
  expect(repairExtractionOverlap(source, units, selection)).toBeNull();
});
it('does not reassign overlapping primary parts across events or another event as context', () => {
  const units = sourceUnits(text);
  for (const events of [
    [{ parts: [range('u1', 'u2')], context: [] }, { parts: [range('u2')], context: [] }],
    [{ parts: [range('u1')], context: [range('u2')] }, { parts: [range('u2')], context: [] }],
  ]) expect(repairExtractionOverlap(text, units, { events, omitted: [{ id: 'u0', reason: 'heading' }] })).toBeNull();
});
it.each(['unknown', 'backwards', 'invented', 'ambiguous', 'uncovered'] as const)('does not invent a fix for %s anchors/coverage', change => {
  const source = 'Acme shipped; Acme shipped; Beta shipped.';
  const selection: EventSelection = { events: [{ parts: [range('u0'), range('u0')], context: [] }], omitted: [] };
  if (change === 'unknown') selection.events[0]!.parts.push(range('u99'));
  if (change === 'backwards') selection.events[0]!.parts.push(range('u1', 'u0'));
  if (change === 'invented') selection.events[0]!.parts[0]!.excerpt = 'Acme released a GPU';
  if (change === 'ambiguous') selection.events[0]!.parts[0]!.excerpt = 'Acme shipped';
  if (change === 'uncovered') selection.events[0]!.parts = [range('u0', 'u0', 'Beta shipped.'), range('u0', 'u0', 'Beta shipped.')];
  expect(repairExtractionOverlap(source, sourceUnits(source), selection)).toBeNull();
});
it('does not transform valid selections or manufacture an event from an empty selection', () => {
  const valid = { events: [{ parts: [range('u0', 'u2')], context: [] }], omitted: [] };
  expect(selectedEvents(text, sourceUnits(text), valid)).not.toBeNull();
  expect(repairExtractionOverlap(text, sourceUnits(text), valid)).toBeNull();
  expect(repairExtractionOverlap(text, sourceUnits(text), { events: [], omitted: [] })).toBeNull();
});
