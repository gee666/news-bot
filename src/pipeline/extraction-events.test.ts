import { describe, expect, it, vi } from 'vitest';
import { selectedEvents, sourceUnits, selectionFeedback, type EventSelection } from './extraction-boundaries.js';
import { eventText, eventSpans } from './extraction-store.js';
import { extractEvents } from './extraction-model.js';
import { modelResult } from './generation.test-helpers.js';
const range = (first: string, last = first, excerpt: string | null = null) => ({ first, last, excerpt });

describe('multi-span news mentions', () => {
  it('keeps detached details with their roundup item, not the intervening item', () => {
    const text = 'News of the week: Acme launched an assistant.\nIt has memory.\nBeta updated its editor.\nThe assistant is free and quota-free.';
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
    const text = 'News roundup at Acme Day in Oslo.\nRumors suggest:\nAn agent forum.\nA security model.\nProtesters arrived outside.';
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
  it('resolves explicit roundup items within one sentence with shared context', () => {
    const text = 'News of the week: Compiler A shipped and Security B launched.';
    const selection: EventSelection = { events: [
      { parts: [range('u0', 'u0', 'Compiler A shipped')], context: [range('u0', 'u0', 'News of the week:')] },
      { parts: [range('u0', 'u0', 'and Security B launched.')], context: [range('u0', 'u0', 'News of the week:')] },
    ], omitted: [] };
    const result = selectedEvents(text, sourceUnits(text), selection);
    expect(result).toHaveLength(2);
    expect(result?.[1] && eventText(text, result[1])).toContain('Security B');
    const second = selection.events[1];
    if (!second) throw new Error('Missing fixture event');
    second.parts[0] = range('u0', 'u0', 'Security B launched.');
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
  it.each([
    'Google presented Gemini 4 Argon and Antigravity demos.\nOne demo uses Lyria for background music.\nLyria can generate music in several styles.',
    'A research paper introduces Agent X.\nExperiments use Model Y and Tool Z.\nModel Y also supports image generation.',
  ])('instructs one extraction call to keep the main topic, not secondary products: %s', async text => {
    const partition = { events: [{ parts: [range('u0')], context: [range('u1')] }],
      omitted: [{ id: 'u2', last: null, excerpt: null, reason: 'non_news' }] };
    const generator = { generate: vi.fn().mockResolvedValueOnce(modelResult(partition)) };
    const events = await extractEvents(text, generator, { operationId: 'extract' }, vi.fn(), 'Technology news');
    expect(events.map(event => eventText(text, event))).toEqual([text.split('\n').slice(0, 2).join('\n\n')]);
    expect(generator.generate).toHaveBeenCalledOnce();
    for (const [request] of generator.generate.mock.calls) {
      expect(request.systemPrompt).toContain('A source item normally yields exactly ONE event');
      expect(request.systemPrompt).toContain('headline and opening framing');
      expect(request.systemPrompt).toContain('A single research post, paper or article is ONE event');
      expect(request.systemPrompt).toContain('or explicitly omitted, NEVER separate events');
      expect(request.systemPrompt).toContain('The only exception is an explicit news roundup/digest');
      expect(request.systemPrompt).toContain('A paragraph about a secondary product inside another story is NOT a roundup');
      expect(request.systemPrompt).not.toMatch(/separate independently announced products|Keep every named product update|Restore missing news, recap products|FOUR candidates/u);
    }
  });
  it('accepts a locally valid empty partition without a second model call', async () => {
    const partition = { events: [], omitted: [{ id: 'u0', last: null, excerpt: null, reason: 'non_news' }] };
    const generator = { generate: vi.fn().mockResolvedValueOnce(modelResult(partition)) };
    expect(await extractEvents('No news.', generator, { operationId: 'extract' }, vi.fn(), 'Technology news')).toEqual([]);
    expect(generator.generate).toHaveBeenCalledOnce();
  });
});

it('repairs an overlapping omission using exact local validation feedback', async () => {
  const text = 'At Acme Day.\nA product launched.';
  const invalid = { events: [{ parts: [range('u1')], context: [range('u0')] }],
    omitted: [{ id: 'u0', last: null, excerpt: null, reason: 'non_news' }] };
  const valid = { ...invalid, omitted: [] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(invalid)).mockResolvedValueOnce(modelResult(valid));
  const events = await extractEvents(text, { generate }, { operationId: 'extract-feedback' }, vi.fn(), 'Technology');
  expect(events).toHaveLength(1);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1]?.[0].prompt).toContain('events[0].context[0]');
  expect(generate.mock.calls[1]?.[0].prompt).toContain('omitted[0]');
});
