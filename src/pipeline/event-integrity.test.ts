import { expect, it, vi } from 'vitest';
import { currentSourceEvents } from './extraction.js';
import { eventDecisionInput, type EventInput } from './consolidation-input.js';
import { EXTRACTION_VERSION, eventText } from './extraction-store.js';
import { jevTemplates } from '../models/templates.js';
import { failureMetadata, ModelRequestError, RequestFault } from '../models/errors.js';
const context = { id: 'event-integrity', attempt: 1, batchId: null, revisionId: null, storyId: null };
const answer = (choice: string) => ({ type: 'choice' as const, choice, probabilities: {}, confidence: 1 });
it('checks historical comparisons against their source, preserving the actual Gemini event', async () => {
  const paragraphs = ['Google released Gemini 4 Argon to vetted cybersecurity testers.',
    'The cautious rollout mirrors Anthropic, which has kept Mythos Preview restricted.',
    'Washington briefly forced Anthropic to suspend access in June.',
    'OpenAI models broke out of a sealed test environment in July.'];
  const text = paragraphs.join('\n\n');
  const events = paragraphs.map(paragraph => ({ parts: [{ start: text.indexOf(paragraph), end: text.indexOf(paragraph) + paragraph.length }], context: [] }));
  const judge = { judge: vi.fn().mockResolvedValueOnce(answer('current')).mockResolvedValue(answer('background')) };
  const selected = await currentSourceEvents(text, events, judge, context);
  expect(selected.map(event => eventText(text, event))).toEqual([paragraphs[0]]);
  expect(judge.judge).toHaveBeenCalledTimes(4);
  expect(judge.judge.mock.calls[1]?.[0]).toBe('extraction_event_role');
  expect(judge.judge.mock.calls[1]?.[1]).toEqual({ sourceText: text, candidate: paragraphs[1] });
});
it('keeps explicit release recaps, genuine secondary announcements and rumor qualifiers', async () => {
  const text = 'Rumors from DevDay:\nAcme will release Compiler A.\nBeta announced Database B.';
  const events = [{ parts: [{ start: text.indexOf('Acme'), end: text.indexOf('\nBeta') }], context: [{ start: 0, end: text.indexOf('\n') }] },
    { parts: [{ start: text.indexOf('Beta'), end: text.length }], context: [] }];
  const judge = { judge: vi.fn().mockResolvedValue(answer('current')) };
  expect(await currentSourceEvents(text, events, judge, context)).toEqual(events);
  expect(judge.judge.mock.calls[0]?.[1]).toEqual({ sourceText: text,
    candidate: 'Rumors from DevDay:\n\nAcme will release Compiler A.' });
});
it.each([16608, 32768, 65536])('preserves every source/candidate byte for a %i-character document without redundant copies', async length => {
  const tail = 'price and access remain.';
  const text = 'Reported rumor: '.padEnd(length - tail.length, 'x') + tail;
  const event = { parts: [{ start: 16, end: text.length }], context: [{ start: 0, end: 16 }] };
  const events = [event];
  const judge = { judge: vi.fn().mockResolvedValue(answer('current')) };
  expect(await currentSourceEvents(text, events, judge, context)).toEqual(events);
  expect(judge.judge.mock.calls[0]?.[1]).toEqual({ sourceText: text, candidate: eventText(text, event) });
});
it('propagates a genuine remaining context rejection without truncation, fake acceptance or another call', async () => {
  const text = 'Full source '.repeat(4000);
  const event = { parts: [{ start: 0, end: text.length }], context: [] };
  const failure = new ModelRequestError(failureMetadata(new RequestFault('context_limit', { status: 400, outcome: 'rejected' }),
    context.id, 'jev', 1, 0));
  const judge = { judge: vi.fn().mockRejectedValue(failure) };
  await expect(currentSourceEvents(text, [event], judge, context)).rejects.toBe(failure);
  expect(judge.judge).toHaveBeenCalledOnce();
  expect(judge.judge.mock.calls[0]?.[1]).toEqual({ sourceText: text, candidate: text });
});
it('fails closed on an invalid role rather than silently discarding news', async () => {
  await expect(currentSourceEvents('Release.', [{ parts: [{ start: 0, end: 8 }], context: [] }],
    { judge: vi.fn().mockResolvedValue(answer('invalid')) }, context)).rejects.toThrow('Invalid source event role');
});
it('keeps distribution identities and separate reports in matching and consolidation inputs', () => {
  const artifact: EventInput = { id: 'artifact', text: 'GLM-5.3 uncensored released.', fingerprint: 'a',
    reports: [{ text: 'GLM-5.3 uncensored released.', sourceUrl: 'https://t.me/whackdoor/31902',
      links: ['https://huggingface.co/Infatoshi/GLM-5.3-UNCENSORED-EXL3-3.0bpw'] }] };
  const hosted: EventInput = { id: 'hosted', text: 'GLM-5.3 uncensored API for $20.', fingerprint: 'b',
    reports: [{ text: 'GLM-5.3 uncensored API for $20.', sourceUrl: 'https://t.me/AcidCrunch/2852', links: ['https://abliteration.ai/'] }] };
  const decision = eventDecisionInput(artifact, hosted);
  expect(decision).toEqual(eventDecisionInput(hosted, artifact));
  expect(decision.reportGroups).toEqual(expect.arrayContaining([artifact.reports, hosted.reports]));
  expect(decision.candidate).toBe(hosted.text);
  expect(jevTemplates.duplicate.questions.relation.instructions).toContain('downloadable quantized checkpoint');
  expect(jevTemplates.duplicate.questions.relation.instructions).toContain('All core developments');
  expect(jevTemplates.event_group_integrity.questions.integrity.instructions).toContain('preview-to-release');
});
it('invalidates extraction and matching receipts for changed event boundaries', () => {
  expect(EXTRACTION_VERSION).toBe('events-v5');
  expect(jevTemplates.duplicate.version).toBe('duplicate-v4');
});
