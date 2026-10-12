import { describe, expect, it, vi } from 'vitest';
import { deterministicEligible, deterministicSpans } from './extraction.js';
import { extractWithGenerator, selectedEvents, sourceUnits } from './extraction-fallback.js';
import { modelResult } from './generation.test-helpers.js';

interface ExtractionSelection {
  events: { first: string; last: string; excerpt?: string | null }[];
  omitted: { id: string; reason: string; excerpt?: string | null }[];
}
function selectedSpans(text: string, units: ReturnType<typeof sourceUnits>, selection: ExtractionSelection) {
  const result = selectedEvents(text, units, { events: selection.events.map(event => ({ parts: [{ ...event, excerpt: event.excerpt ?? null }], context: [] })),
    omitted: selection.omitted.map(unit => ({ ...unit, excerpt: unit.excerpt ?? null, reason: unit.reason === 'heading' ? 'heading' : 'non_news' })) });
  return result?.flatMap(event => event.parts) ?? null;
}
function selectionResult(selection: ExtractionSelection) {
  return modelResult({ events: selection.events.map(event => ({ parts: [{ ...event, excerpt: event.excerpt ?? null }], context: [] })),
    omitted: selection.omitted.map(unit => ({ ...unit, last: null, excerpt: unit.excerpt ?? null })) });
}
const headingRoundup = 'Developer news:\n\nAcme released compiler 2.\n\nBeta launched a database.';
const releaseRoundup = 'Acme introduced an assistant:\n\nIt remembers preferences.\n\nIt has a browser.\n\nBeta updated its editor.\n\nThe assistant is free on all plans.';

describe('conservative deterministic eligibility', () => {
  it.each([headingRoundup, releaseRoundup])('never accepts paragraph fragments even with a confident JEV score', text => {
    for (const hint of ['1', '2', '3', 'more']) {
      expect(deterministicEligible(text, hint, deterministicSpans(text, hint))).toBe(false);
    }
  });
  it('routes multi-event and count/split disagreement to fallback, not a forced count', () => {
    const text = 'Acme released compiler 2. Beta launched a database.';
    expect(deterministicEligible(text, '2', deterministicSpans(text, '2'))).toBe(false);
    expect(deterministicEligible('Acme released compiler 2.', '1', [{ start: 0, end: 'Acme released compiler 2.'.length }])).toBe(true);
  });
});

describe('source coordinate selections', () => {
  it('omits a heading and groups each complete event without generated text', () => {
    const units = sourceUnits(headingRoundup);
    const spans = selectedSpans(headingRoundup, units, {
      events: [{ first: 'u1', last: 'u1' }, { first: 'u2', last: 'u2' }], omitted: [{ id: 'u0', reason: 'heading' }],
    });
    expect(spans?.map(s => headingRoundup.slice(s.start, s.end))).toEqual(['Acme released compiler 2.', 'Beta launched a database.']);
  });
  it('keeps release features together and excludes detached detail rather than inventing a third event', () => {
    const units = sourceUnits(releaseRoundup);
    const spans = selectedSpans(releaseRoundup, units, {
      events: [{ first: 'u0', last: 'u2' }, { first: 'u3', last: 'u3' }], omitted: [{ id: 'u4', reason: 'unattached_detail' }],
    });
    expect(spans).toHaveLength(2);
    expect(spans?.map(s => releaseRoundup.slice(s.start, s.end))).toEqual([
      'Acme introduced an assistant:\n\nIt remembers preferences.\n\nIt has a browser.', 'Beta updated its editor.',
    ]);
  });
  it('splits two announcements inside one sentence using exact anchors, not model offsets', () => {
    const text = 'Acme released compiler 2; Beta announced a new GPU.';
    const units = sourceUnits(text);
    expect(units).toHaveLength(1);
    const spans = selectedSpans(text, units, { events: [
      { first: 'u0', last: 'u0', excerpt: 'Acme released compiler 2' },
      { first: 'u0', last: 'u0', excerpt: 'Beta announced a new GPU.' },
    ], omitted: [] });
    expect(spans?.map(span => text.slice(span.start, span.end))).toEqual(['Acme released compiler 2', 'Beta announced a new GPU.']);
    expect(spans?.[1]?.start).toBe(text.indexOf('Beta'));
    expect(selectedSpans(text, units, { events: [{ first: 'u0', last: 'u0', excerpt: 'Acme released compiler 2' }], omitted: [] })).toBeNull();
    expect(selectedSpans(text, units, { events: [{ first: 'u0', last: 'u0', excerpt: 'Acme released compiler 3' }], omitted: [] })).toBeNull();
  });
  it('rejects ambiguous or overlapping within-unit anchors', () => {
    const text = 'Acme shipped; Acme shipped; Beta shipped.';
    const units = sourceUnits(text);
    expect(selectedSpans(text, units, { events: [{ first: 'u0', last: 'u0', excerpt: 'Acme shipped' }], omitted: [] })).toBeNull();
    expect(selectedSpans(text, units, { events: [{ first: 'u0', last: 'u0' },
      { first: 'u0', last: 'u0', excerpt: 'Beta shipped.' }], omitted: [] })).toBeNull();
  });
  it('requires exhaustive coverage, known coordinates and no overlap', () => {
    const units = sourceUnits(headingRoundup);
    expect(selectedSpans(headingRoundup, units, { events: [{ first: 'u1', last: 'u1' }], omitted: [] })).toBeNull();
    expect(selectedSpans(headingRoundup, units, { events: [{ first: 'u0', last: 'u9' }], omitted: [] })).toBeNull();
    expect(selectedSpans(headingRoundup, units, { events: [{ first: 'u0', last: 'u2' }], omitted: [{ id: 'u1', reason: 'heading' }] })).toBeNull();
  });
  it('computes exact JavaScript UTF-16 offsets for Cyrillic, emoji, CRLF and non-breaking spaces', () => {
    const text = '🚀 Новости:\r\n\r\nКомпания выпустила\u00a0модель.\r\n\r\n🧠 Другой релиз.';
    const units = sourceUnits(text);
    const spans = selectedSpans(text, units, {
      events: [{ first: 'u1', last: 'u1' }, { first: 'u2', last: 'u2' }], omitted: [{ id: 'u0', reason: 'heading' }],
    });
    expect(spans?.[0]?.start).toBe(text.indexOf('Компания'));
    expect(spans?.[1]?.start).toBe(text.indexOf('🧠'));
    expect(spans?.map(s => text.slice(s.start, s.end))).toEqual(['Компания выпустила\u00a0модель.', '🧠 Другой релиз.']);
  });
  it('repairs incomplete source coverage once using the production structured adapter', async () => {
    const generator = { generate: vi.fn()
      .mockResolvedValueOnce(selectionResult({ events: [{ first: 'u1', last: 'u1' }], omitted: [] }))
      .mockResolvedValue(selectionResult({ events: [{ first: 'u1', last: 'u1' }, { first: 'u2', last: 'u2' }], omitted: [{ id: 'u0', reason: 'heading' }] })) };
    const recordFailure = vi.fn();
    const result = await extractWithGenerator(headingRoundup, generator, { operationId: 'extraction-test' }, recordFailure);
    expect(result.repaired).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(generator.generate.mock.calls[0]?.[0].prompt).not.toContain('count_hint');
    expect(recordFailure).not.toHaveBeenCalled();
  });
  it('leaves the stage failed after two invalid outputs rather than guessing missing boundaries', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [] })) };
    const recordFailure = vi.fn();
    await expect(extractWithGenerator(headingRoundup, generator, { operationId: 'extraction-test' }, recordFailure)).rejects.toThrow();
    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalid_output' }));
  });
});
