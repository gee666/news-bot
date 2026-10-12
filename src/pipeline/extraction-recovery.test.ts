import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { ModelRequestError, RequestFault, failureMetadata } from '../models/errors.js';
import type { Judgments } from './judgments.js';
import { confirmCandidatePartition, confirmNoNews, currentSourceEvents, messageHasEligibleNews } from './extraction.js';
import { extractWithGenerator } from './extraction-fallback.js';
import { selectedEvents, sourceUnits, type EventSelection } from './extraction-boundaries.js';
import { eventText, type ExtractedEvent } from './extraction-store.js';
import { modelResult } from './generation.test-helpers.js';

const context = { id: 'extraction-stage', attempt: 1, batchId: null, revisionId: null, storyId: null };
const requestContext = { operationId: context.id, attempt: context.attempt };
const choice = (value: string) => ({ type: 'choice' as const, choice: value, probabilities: {}, confidence: 1 });
const coherent = { type: 'noul' as const, noul: 1 };
const range = (first: string, last = first, excerpt: string | null = null) => ({ first, last, excerpt });
function verifier(...answers: Awaited<ReturnType<Judgments['judge']>>[]) {
  const judge = { judge: vi.fn<Judgments['judge']>() };
  for (const answer of answers) judge.judge.mockResolvedValueOnce(answer);
  return judge;
}
function events(text: string, selection: EventSelection): ExtractedEvent[] {
  const result = selectedEvents(text, sourceUnits(text), selection);
  if (!result) throw new Error('Invalid fixture partition');
  return result;
}
const text = 'Acme released Compiler 2.\nIt fixes a security flaw.';
const complete = { events: [{ parts: [range('u0', 'u1')], context: [] }], omitted: [] };

it('recovers duplicate primary coordinates after the bounded repair instead of withholding valid news', async () => {
  const overlapping = { ...complete, events: [{ parts: [range('u0', 'u1'), range('u1')], context: [] }] };
  const generate = vi.fn().mockResolvedValue(modelResult(overlapping));
  const judge = verifier(choice('eligible'), coherent);
  const record = vi.fn();
  const result = await extractWithGenerator(text, { generate }, requestContext, record, undefined,
    candidates => confirmCandidatePartition(text, candidates, judge, context, defaultSettings));
  expect(result).toMatchObject({ resolution: 'repaired_overlap', repaired: true, emptyConfirmed: false,
    events: [{ parts: [{ start: 0, end: text.length }], context: [] }] });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalid_output', validation: expect.objectContaining({ codes: ['extraction_overlap'] }) }));
  expect(judge.judge.mock.calls.map(([template]) => template)).toEqual(['news_eligibility', 'split_validation']);
});
it.each(['heading', 'non_news'])('repairs redundant %s omissions while retaining qualified shared preview context for each event', async reason => {
  const source = 'Rumors about tomorrow:\nAcme may introduce a new forum.\nBeta may release a security model.';
  const overlapping = { events: [
    { parts: [range('u1')], context: [range('u0')] }, { parts: [range('u2')], context: [range('u0')] },
  ], omitted: [{ id: 'u0', last: null, excerpt: null, reason }] };
  const generate = vi.fn().mockResolvedValue(modelResult(overlapping));
  const judge = verifier(choice('eligible'), coherent, choice('eligible'), coherent);
  const result = await extractWithGenerator(source, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(source, candidates, judge, context, defaultSettings));
  expect(result.resolution).toBe('repaired_overlap');
  expect(result.events.map(event => eventText(source, event))).toEqual([
    'Rumors about tomorrow:\n\nAcme may introduce a new forum.',
    'Rumors about tomorrow:\n\nBeta may release a security model.',
  ]);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(judge.judge).toHaveBeenCalledTimes(4);
});

it('keeps a valid initial event when a broken review repeats cross-event overlap', async () => {
  const invalid = { ...complete, events: [...complete.events, { parts: [range('u1')], context: [] }] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(complete)).mockResolvedValue(modelResult(invalid));
  const judge = verifier(choice('eligible'), coherent);
  const result = await extractWithGenerator(text, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(text, candidates, judge, context, defaultSettings));
  expect(result.resolution).toBe('verified_initial');
  expect(result.events).toEqual(events(text, complete));
  expect(generate).toHaveBeenCalledTimes(3);
  expect(judge.judge).toHaveBeenLastCalledWith('split_validation', { message: { text },
    proposedSpans: [{ start: 0, end: text.length, text }] }, context);
});
it('prefers independently verified repaired review coordinates over a fragmented initial partition', async () => {
  const fragmented = { events: [{ parts: [range('u0')], context: [] }, { parts: [range('u1')], context: [] }], omitted: [] };
  const reviewed = { ...complete, events: [{ parts: [range('u0', 'u1'), range('u1')], context: [] }] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(fragmented)).mockResolvedValue(modelResult(reviewed));
  const judge = verifier(choice('eligible'), coherent);
  const result = await extractWithGenerator(text, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(text, candidates, judge, context, defaultSettings));
  expect(result.resolution).toBe('repaired_overlap');
  expect(result.events).toEqual(events(text, complete));
  expect(judge.judge).toHaveBeenCalledTimes(2);
});
it.each(['malformed_json', 'unknown_id', 'missing_coverage'] as const)('can reuse only independently checked original coordinates after %s review failure', async failure => {
  const bad = failure === 'malformed_json' ? '{}{}' : failure === 'unknown_id'
    ? { events: [{ parts: [range('u0', 'u999')], context: [] }], omitted: [] }
    : { events: [{ parts: [range('u0')], context: [] }], omitted: [] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(complete)).mockResolvedValue(modelResult(bad));
  const judge = verifier(choice('eligible'), coherent);
  const result = await extractWithGenerator(text, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(text, candidates, judge, context, defaultSettings));
  expect(result.resolution).toBe('verified_initial');
  expect(result.events).toEqual(events(text, complete));
  expect(generate).toHaveBeenCalledTimes(3);
});
it('retains independently eligible news without upgrading a rejected ad sibling into an event', async () => {
  const source = 'Acme released Compiler 2.\nBuy our unrelated programming course.';
  const initial = { events: [{ parts: [range('u0')], context: [] }, { parts: [range('u1')], context: [] }], omitted: [] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(initial)).mockResolvedValue(modelResult('{}{}'));
  const judge = verifier(choice('eligible'), coherent, choice('rejected'));
  const result = await extractWithGenerator(source, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(source, candidates, judge, context, defaultSettings));
  expect(result.events.map(event => eventText(source, event))).toEqual(['Acme released Compiler 2.']);
  expect(judge.judge.mock.calls.map(([template]) => template)).toEqual(['news_eligibility', 'split_validation', 'news_eligibility']);
});
it.each(['course advertisement', 'evergreen tutorial', 'generic product catalog'])('does not recover an entire %s as news', async category => {
  const source = `${category}.\nLearn to use AI tools and buy our course.`;
  const initial = { events: [{ parts: [range('u0', 'u1')], context: [] }], omitted: [] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(initial)).mockResolvedValue(modelResult('{}{}'));
  const judge = verifier(choice('rejected'));
  await expect(extractWithGenerator(source, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(source, candidates, judge, context, defaultSettings))).rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
  expect(judge.judge).toHaveBeenCalledOnce();
});
it('does not guess a split for an independently eligible but merged multi-news candidate', async () => {
  const source = 'Acme released Compiler 2. Beta launched a new GPU.';
  const last = sourceUnits(source).at(-1)?.id;
  if (!last) throw new Error('Missing unit');
  const initial = { events: [{ parts: [range('u0', last)], context: [] }], omitted: [] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(initial)).mockResolvedValue(modelResult('{}{}'));
  const judge = verifier(choice('eligible'), { type: 'noul', noul: 0.2 });
  await expect(extractWithGenerator(source, { generate }, requestContext, vi.fn(), undefined,
    candidates => confirmCandidatePartition(source, candidates, judge, context, defaultSettings))).rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
  expect(generate).toHaveBeenCalledTimes(3);
});
it.each(['invented', 'duplicate', 'widened'] as const)('rejects %s boundaries returned by an independent callback', async mutation => {
  const generate = vi.fn().mockResolvedValueOnce(modelResult(complete)).mockResolvedValue(modelResult('{}{}'));
  const original = events(text, complete);
  const accepted = mutation === 'duplicate' ? [...original, ...original] : [{ parts: [{ start: mutation === 'invented' ? 1 : 0,
    end: mutation === 'widened' ? text.length + 10 : text.length }], context: [] }];
  await expect(extractWithGenerator(text, { generate }, requestContext, vi.fn(), undefined, async () => accepted)).rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
});
it('never uses repair to promote a profile-excluded ad block or synthesize missing news', async () => {
  const source = 'Buy our AI programming course.\nAcme released Compiler 2.';
  const invalid = { events: [{ parts: [range('u0', 'u1')], context: [] }],
    omitted: [{ id: 'u0', last: null, excerpt: null, reason: 'profile_excluded' }] };
  const generate = vi.fn().mockResolvedValue(modelResult(invalid));
  const confirm = vi.fn().mockResolvedValue(true);
  await expect(extractWithGenerator(source, { generate }, requestContext, vi.fn(), undefined, confirm)).rejects.toMatchObject({ metadata: { validation: { codes: ['extraction_overlap'] } } });
  expect(confirm).not.toHaveBeenCalled();
});
it('does not bypass provider uncertainty or independent admission failures', async () => {
  const timeout = new ModelRequestError(failureMetadata(new RequestFault('timeout', { outcome: 'unknown' }), `${context.id}:review`, 'pi', 1, 0));
  const generate = vi.fn().mockResolvedValueOnce(modelResult(complete)).mockRejectedValueOnce(timeout);
  const confirm = vi.fn().mockResolvedValue(true);
  await expect(extractWithGenerator(text, { generate }, requestContext, vi.fn(), undefined, confirm)).rejects.toBe(timeout);
  expect(confirm).not.toHaveBeenCalled();
  generate.mockResolvedValueOnce(modelResult(complete)).mockResolvedValue(modelResult('{}{}'));
  const failure = new ModelRequestError(failureMetadata(new RequestFault('context_limit', { outcome: 'not_submitted' }), context.id, 'jev', 1, 0));
  confirm.mockRejectedValueOnce(failure);
  await expect(extractWithGenerator(text, { generate }, requestContext, vi.fn(), undefined, confirm)).rejects.toBe(failure);
});
it('validates only exact candidate text and preserves original-source historical role checks', async () => {
  const source = 'Acme released Compiler 2.\nBeta launched a GPU years ago.';
  const selected = { events: [{ parts: [range('u0')], context: [] }, { parts: [range('u1')], context: [] }], omitted: [] };
  const candidates = events(source, selected);
  const judge = verifier(choice('eligible'), coherent, choice('eligible'), coherent, choice('current'), choice('background'));
  expect(await confirmCandidatePartition(source, candidates, judge, context, defaultSettings)).toEqual(candidates);
  expect(await currentSourceEvents(source, candidates, judge, context)).toEqual([candidates[0]]);
  expect(judge.judge.mock.calls[4]).toEqual(['extraction_event_role', { sourceText: source, candidate: 'Acme released Compiler 2.' }, context]);
});
it.each(['eligibility', 'candidate_eligibility', 'admission', 'source_role'] as const)('classifies an unexpected %s answer as a definite local output error, not permission to discard or invent news', async phase => {
  const judge = verifier(...(phase === 'admission' ? [choice('eligible'), choice('unexpected')] : [choice('unexpected')]));
  const candidates = events(text, complete);
  const run = phase === 'eligibility' ? messageHasEligibleNews(text, judge, context, defaultSettings)
    : phase === 'candidate_eligibility' ? confirmCandidatePartition(text, candidates, judge, context, defaultSettings)
    : phase === 'admission' ? confirmNoNews(text, judge, context, defaultSettings) : currentSourceEvents(text, candidates, judge, context);
  await expect(run).rejects.toMatchObject({ code: 'invalid_output', name: 'StageOutputError' });
});

it('declines empty or invalid coordinate candidates before sending them to independent inference', async () => {
  const judge = verifier();
  expect(await confirmCandidatePartition(text, [], judge, context, defaultSettings)).toBe(false);
  expect(await confirmCandidatePartition(text, [{ parts: [{ start: 0, end: text.length + 1 }], context: [] }], judge, context, defaultSettings)).toBe(false);
  expect(judge.judge).not.toHaveBeenCalled();
});
