import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { JevClient, type JevResult } from '../models/jev.js';
import { ModelRequestError, RequestFault, failureMetadata } from '../models/errors.js';
import { jevTemplates } from '../models/templates.js';
import { defaultSettings } from '../settings.js';
import type { EventInput } from './consolidation-input.js';
import { groupingState } from './grouping-input.js';
import { GROUPING_VERSION, groupReport } from './grouping-model.js';
import { approveRemoteInput } from './privacy.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';

const mocks = vi.hoisted(() => ({ cache: new Map<string, unknown>(), judge: vi.fn(), close: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: vi.fn(async (sql: string, args: unknown[]) => {
  const key = (input: unknown) => JSON.stringify([input, args[1], args[2]]);
  if (sql.includes('SELECT input_hash,value')) return { rows: (args[0] as string[])
    .flatMap(input_hash => mocks.cache.has(key(input_hash)) ? [{ input_hash, value: mocks.cache.get(key(input_hash)) }] : []) };
  mocks.cache.set(key(args[0]), JSON.parse(String(args[3])));
  return { rows: [] };
}) } }));
vi.mock('../models/jev.js', () => ({ JevClient: vi.fn(class {
  judge = mocks.judge;
  close = mocks.close;
}) }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: vi.fn() }));
vi.mock('./generation-model.js', () => ({ generationClient: vi.fn(() => { throw new Error('Pi forbidden'); }) }));
const context = { id: randomUUID(), attempt: 1, batchId: null, revisionId: null, storyId: null };
function report(text: string, sourceUrl = 'https://example.org/news'): EventInput {
  return { id: randomUUID(), text, fingerprint: randomUUID(), reports: [{ text, sourceUrl,
    links: [sourceUrl], publishedAt: '2026-10-26T19:00:00.000Z' }] };
}
function result(choice = 'unrelated'): JevResult {
  return { model: 'autojev', template: 'duplicate', promptVersion: jevTemplates.duplicate.version,
    answers: { relation: { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 1 } },
    usage: { input_tokens: 100, output_tokens: 1 }, metrics: { durationMs: 10 } };
}
beforeEach(() => {
  mocks.cache.clear(); mocks.judge.mockReset().mockResolvedValue(result()); mocks.close.mockReset().mockResolvedValue(undefined);
  vi.mocked(JevClient).mockClear(); vi.mocked(approveRemoteInput).mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('uses only configured JEV for grouping, with full reports and source provenance', async () => {
  const incoming = report('New release'); const candidate = report('Earlier release');
  mocks.judge.mockResolvedValue(result('same'));
  expect(await groupReport(incoming, [candidate], defaultSettings, context))
    .toEqual([{ storyId: candidate.id, relation: 'same' }]);
  expect(JevClient).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseUrl: defaultSettings.jevUrl,
    model: defaultSettings.jevModel, requestMaxAttempts: defaultSettings.requestMaxAttempts }));
  expect(mocks.judge).toHaveBeenCalledExactlyOnceWith('duplicate', {
    incoming: { id: incoming.id, reports: incoming.reports }, candidate: { id: candidate.id, reports: candidate.reports },
  }, { operationId: context.id, attempt: 1, stage: 'grouping' });
  expect(approveRemoteInput).toHaveBeenCalledWith(defaultSettings.jevUrl, context.id, context);
  expect(approveRemoteInput).toHaveBeenCalledWith(defaultSettings.jevUrl, context.id, { storyId: candidate.id });
  expect(mocks.close).toHaveBeenCalledOnce();
  expect(GROUPING_VERSION).toContain('jev');
});
it.each(['same', 'related', 'unrelated'] as const)('accepts the JEV %s verdict without generation or verification calls', async relation => {
  const incoming = report('OpenAI discovered a PHP flaw.'); const candidate = report('Alderon shut down because of the PHP flaw.');
  mocks.judge.mockResolvedValue(result(relation));
  expect(await groupReport(incoming, [candidate], defaultSettings, context)).toEqual([{ storyId: candidate.id, relation,
    ...(relation === 'related' ? { relatedPromptVersion: jevTemplates.duplicate.version } : {}) }]);
  expect(mocks.judge).toHaveBeenCalledOnce();
});
it('keeps the vendor-roundup rule in the actual JEV template', () => {
  const instructions = jevTemplates.duplicate.questions.relation.instructions;
  expect(instructions).toContain('Liquid AI releasing LFM3 models versus S-GAME launching Phantom Blade Zero with NVIDIA graphics support are UNRELATED');
  expect(instructions).toContain('one shared occurrence, not separate products in a vendor update');
  expect(instructions).toContain('Time proximity alone never makes unrelated subjects same');
  expect(instructions).toContain('General forecasts about an industry');
});
it.each(['context_limit', 'timeout', 'authentication'] as const)('propagates %s without a Pi fallback or caching a verdict', async kind => {
  const failure = new ModelRequestError(failureMetadata(new RequestFault(kind), context.id, 'jev', 1, 0));
  mocks.judge.mockRejectedValue(failure);
  await expect(groupReport(report('New'), [report('Old')], defaultSettings, context)).rejects.toBe(failure);
  expect(mocks.judge).toHaveBeenCalledOnce(); expect(mocks.cache.size).toBe(0); expect(mocks.close).toHaveBeenCalledOnce();
});
it('does not call or construct a classifier with no candidates or fully cached pairs', async () => {
  const incoming = report('Release'); const candidate = report('Earlier');
  expect(await groupReport(incoming, [], defaultSettings, context)).toEqual([]);
  expect(JevClient).not.toHaveBeenCalled();
  await groupReport(incoming, [candidate], defaultSettings, context);
  vi.mocked(JevClient).mockClear(); mocks.judge.mockClear();
  expect(await groupReport(incoming, [candidate], defaultSettings, context)).toEqual([{ storyId: candidate.id, relation: 'unrelated' }]);
  expect(JevClient).not.toHaveBeenCalled(); expect(mocks.judge).not.toHaveBeenCalled();
});
it('rejects malformed JEV answers without treating them as unrelated or caching them', async () => {
  mocks.judge.mockResolvedValue(result('update'));
  await expect(groupReport(report('New'), [report('Old')], defaultSettings, context)).rejects.toThrow();
  expect(mocks.cache.size).toBe(0); expect(mocks.judge).toHaveBeenCalledOnce();
});
it('resumes after a processing checkpoint without repeating a completed pair', async () => {
  vi.stubEnv('PROCESSING_SLICE_MS', '1000'); let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  mocks.judge.mockImplementation(async () => { clock += 1001; return result(); });
  const incoming = report('New'); const candidates = [report('One'), report('Two')];
  await expect(withProcessingSlice(() => groupReport(incoming, candidates, defaultSettings, context))).rejects.toBeInstanceOf(ProcessingYield);
  expect(mocks.cache.size).toBe(1);
  expect(await withProcessingSlice(() => groupReport(incoming, candidates, defaultSettings, context))).toHaveLength(2);
  expect(mocks.judge).toHaveBeenCalledTimes(2);
});
it('retains completed pairs after failure and candidate insertion or reranking', async () => {
  const incoming = report('New'); const candidates = [report('One'), report('Two')]; const inserted = report('Inserted');
  mocks.judge.mockResolvedValueOnce(result('same')).mockRejectedValueOnce(new Error('Unavailable'));
  await expect(groupReport(incoming, candidates, defaultSettings, context)).rejects.toThrow('Unavailable');
  expect(mocks.cache.size).toBe(1);
  mocks.judge.mockResolvedValue(result('unrelated'));
  expect(await groupReport(incoming, [inserted, ...candidates], defaultSettings, { ...context, attempt: 2 })).toEqual([
    { storyId: inserted.id, relation: 'unrelated' }, { storyId: candidates[0]?.id, relation: 'same' },
    { storyId: candidates[1]?.id, relation: 'unrelated' },
  ]);
  expect(mocks.judge).toHaveBeenCalledTimes(4);
});
it('uses only the first ranked same match without manufacturing related links', async () => {
  const incoming = report('New'); const candidates = [report('One'), report('Two'), report('Three')];
  mocks.judge.mockResolvedValue(result('same'));
  expect(await groupReport(incoming, candidates, defaultSettings, context)).toEqual([{ storyId: candidates[0]?.id, relation: 'same' }]);
  expect(mocks.judge).toHaveBeenCalledTimes(3);
});
it('invalidates pairs for changed evidence, timestamps and JEV settings, not Pi settings or local receipts', async () => {
  const incoming = report('New'); const candidate = report('Old');
  await groupReport(incoming, [candidate], defaultSettings, context);
  await groupReport({ ...incoming, fingerprint: 'new-local-receipt' }, [candidate], { ...defaultSettings, piModel: 'other' }, context);
  expect(mocks.judge).toHaveBeenCalledOnce();
  await groupReport(incoming, [candidate], { ...defaultSettings, jevModel: 'other' }, context);
  await groupReport(incoming, [candidate], { ...defaultSettings, jevUrl: 'http://localhost:8877' }, context);
  await groupReport(incoming, [candidate], { ...defaultSettings, modelVersion: defaultSettings.modelVersion + 1 }, context);
  await groupReport(incoming, [{ ...candidate, reports: [{ ...candidate.reports[0]!, publishedAt: '2026-10-27T19:00:00.000Z' }] }], defaultSettings, context);
  await groupReport({ ...incoming, reports: [{ ...incoming.reports[0]!, text: 'Changed' }] }, [candidate], defaultSettings, context);
  expect(mocks.judge).toHaveBeenCalledTimes(6);
});
it('compares every retained group, preserving all reports rather than a shortlist', async () => {
  const incoming = report('New'); const candidates = Array.from({ length: 703 }, (_, i) => report(`Story ${i}`));
  expect(await groupReport(incoming, candidates, defaultSettings, context)).toHaveLength(703);
  expect(mocks.judge).toHaveBeenCalledTimes(703);
  const seen = mocks.judge.mock.calls.map(([, state]) => state);
  expect(seen).toEqual(candidates.map(candidate => groupingState(incoming, candidate)));
});
