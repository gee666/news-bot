import { describe, expect, it, vi } from 'vitest';
import { selectedEvents, sourceUnits, selectionFeedback, type EventSelection } from './extraction-boundaries.js';
import { eventText, eventSpans } from './extraction-store.js';
import { extractWithGenerator } from './extraction-fallback.js';
import { modelResult } from './generation.test-helpers.js';
const range = (first: string, last = first, excerpt: string | null = null) => ({ first, last, excerpt });

describe('multi-span news mentions', () => {
  it('keeps detached access and quota details with their own product, not the intervening event', () => {
    const text = 'Acme launched an assistant.\nIt has memory.\nBeta updated its editor.\nThe assistant is free and quota-free.';
    const result = selectedEvents(text, sourceUnits(text), { events: [
      { parts: [range('u0', 'u1'), range('u3')], context: [] },
      { parts: [range('u2')], context: [] },
    ], omitted: [] });
    expect(result).toHaveLength(2);
    expect(result?.[0] && eventText(text, result[0])).toContain('quota-free');
    expect(result?.[0] && eventText(text, result[0])).not.toContain('editor');
    expect(result?.[1] && eventText(text, result[1])).not.toContain('assistant');
    expect(result?.[0] && eventSpans(result[0])).toHaveLength(2);
  });
  it('preserves rumor attribution and shared place context, including overlapping context ranges', () => {
    const text = 'At Acme Day in Oslo.\nRumors suggest:\nAn agent forum.\nA security model.\nProtesters arrived outside.';
    const result = selectedEvents(text, sourceUnits(text), { events: [
      { parts: [range('u2')], context: [range('u0', 'u1')] },
      { parts: [range('u3')], context: [range('u0', 'u1')] },
      { parts: [range('u4')], context: [range('u0')] },
    ], omitted: [] });
    expect(result).toHaveLength(3);
    expect(result?.[0] && eventText(text, result[0])).toContain('Rumors suggest:');
    expect(result?.[2] && eventText(text, result[2])).toContain('Oslo');
    expect(result?.[2] && eventText(text, result[2])).not.toContain('Rumors');
  });
  it('splits a named-product recap within one sentence with shared update context', () => {
    const text = 'Updated tools include Compiler A and Security B.';
    const selection: EventSelection = { events: [
      { parts: [range('u0', 'u0', 'Compiler A')], context: [range('u0', 'u0', 'Updated tools include')] },
      { parts: [range('u0', 'u0', 'and Security B.')], context: [range('u0', 'u0', 'Updated tools include')] },
    ], omitted: [] };
    const result = selectedEvents(text, sourceUnits(text), selection);
    expect(result).toHaveLength(2);
    expect(result?.[1] && eventText(text, result[1])).toContain('Security B');
    const second = selection.events[1];
    if (!second) throw new Error('Missing fixture event');
    second.parts[0] = range('u0', 'u0', 'Security B.');
    expect(selectedEvents(text, sourceUnits(text), selection)).toBeNull();
    expect(selectionFeedback(text, sourceUnits(text), selection)).toContain('and');
  });
  it('omits an excluded block with one exact range while retaining genuine news', () => {
    const text = 'Acme released an API.\nBuy this course.\nStudy these lessons.';
    const result = selectedEvents(text, sourceUnits(text), { events: [{ parts: [range('u0')], context: [] }],
      omitted: [{ id: 'u1', last: 'u2', excerpt: null, reason: 'profile_excluded' }] });
    expect(result?.map(event => eventText(text, event))).toEqual(['Acme released an API.']);
    expect(selectedEvents(text, sourceUnits(text), { events: [{ parts: [range('u0')], context: [] }],
      omitted: [{ id: 'u0', last: 'u2', excerpt: null, reason: 'profile_excluded' }] })).toBeNull();
  });
  it('identifies exact conflicting context and omitted assignments for repair', () => {
    const text = 'At Acme Day.\nA product launched.';
    const value: EventSelection = { events: [{ parts: [range('u1')], context: [range('u0')] }],
      omitted: [{ id: 'u0', last: null, excerpt: null, reason: 'non_news' }] };
    const feedback = selectionFeedback(text, sourceUnits(text), value);
    expect(feedback).toContain('events[0].context[0]');
    expect(feedback).toContain('omitted[0]');
    expect(selectedEvents(text, sourceUnits(text), value)).toBeNull();
  });
  it('rejects duplicated primary facts even though context can be shared', () => {
    const text = 'Acme released a model.';
    expect(selectedEvents(text, sourceUnits(text), { events: [
      { parts: [range('u0')], context: [] }, { parts: [range('u0')], context: [] },
    ], omitted: [] })).toBeNull();
  });
  it('never commits empty extraction after positive count, even if all units were marked non-news', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [{ id: 'u0', last: null, excerpt: null, reason: 'non_news' }] })) };
    await expect(extractWithGenerator('Expected release of Security B.', generator, { operationId: 'positive-count' }, vi.fn())).rejects.toThrow();
    expect(generator.generate).toHaveBeenCalledTimes(2);
  });
});
