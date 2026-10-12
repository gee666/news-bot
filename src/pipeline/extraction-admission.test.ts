import { describe, expect, it, vi } from 'vitest';
import { confirmCandidatePartition, confirmNoNews, messageHasEligibleNews } from './extraction.js';
import { extractWithGenerator, extractionDiagnostic } from './extraction-fallback.js';
import { defaultSettings } from '../settings.js';
import { modelResult } from './generation.test-helpers.js';
const caption = 'Someone waved at the camera.\nWhat a moment!';
const noNews = { events: [], omitted: [
  { id: 'u0', last: null, excerpt: null, reason: 'non_news' }, { id: 'u1', last: null, excerpt: null, reason: 'non_news' },
] };
const context = { id: 'stage', attempt: 2, batchId: null, revisionId: null, storyId: null };
describe('confirmed empty extraction', () => {
  it('accepts a fully covered no-news caption only after independent admission rejects extractability', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(modelResult(noNews)) };
    const judge = { judge: vi.fn().mockResolvedValue({ type: 'choice', choice: 'rejected', probabilities: {}, confidence: 0.9 }) };
    const record = vi.fn();
    const result = await extractWithGenerator(caption, generator, { operationId: 'stage' }, record, () => confirmNoNews(caption, judge, context, defaultSettings));
    expect(result.events).toEqual([]);
    expect(result.emptyConfirmed).toBe(true);
    expect(result.repaired).toBe(false);
    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(judge.judge).toHaveBeenCalledWith('news_eligibility', { story: caption, interestProfile: defaultSettings.interestProfile, scope: 'message' }, context);
    expect(record).not.toHaveBeenCalled();
  });
  it('fails closed rather than losing recap/preview candidates when admission says extractable', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(modelResult(noNews)) };
    const judge = { judge: vi.fn().mockResolvedValueOnce({ type: 'choice', choice: 'eligible', probabilities: {}, confidence: 0.95 })
      .mockResolvedValueOnce({ type: 'choice', choice: 'extractable', probabilities: {}, confidence: 0.95 }) };
    const record = vi.fn();
    await expect(extractWithGenerator(caption, generator, { operationId: 'stage' }, record,
      () => confirmNoNews(caption, judge, context, defaultSettings))).rejects.toThrow('not independently confirmed');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invalid_output', retryable: false }));
  });
  it('does not invoke admission to excuse bad coverage', async () => {
    const generator = { generate: vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [] })) };
    const confirm = vi.fn().mockResolvedValue(true);
    await expect(extractWithGenerator(caption, generator, { operationId: 'stage' }, vi.fn(), confirm)).rejects.toThrow();
    expect(generator.generate).toHaveBeenCalledTimes(2);
    expect(confirm).not.toHaveBeenCalled();
  });
});
describe('message eligibility and editorial disagreement', () => {
  it('uses the supplied immutable profile and existential message scope, not a dominant-ad story predicate', async () => {
    const settings = { ...defaultSettings, interestProfile: 'A changed profile; keep real launches and exclude courses.' };
    const judge = { judge: vi.fn().mockResolvedValue({ type: 'choice', choice: 'eligible', probabilities: {}, confidence: 1 }) };
    expect(await messageHasEligibleNews('A real launch. A much longer course advertisement.', judge, context, settings)).toBe(true);
    expect(judge.judge).toHaveBeenCalledWith('news_eligibility', {
      story: 'A real launch. A much longer course advertisement.', interestProfile: settings.interestProfile, scope: 'message',
    }, context);
  });
  it('keeps an exact valid initial event if an empty editorial review is contradicted by independent verification', async () => {
    const first = { events: [{ parts: [{ first: 'u0', last: 'u1', excerpt: null }], context: [] }], omitted: [] };
    const source = 'Acme released Compiler 2.\nIt fixes a security flaw.';
    const generator = { generate: vi.fn().mockResolvedValueOnce(modelResult(first)).mockResolvedValueOnce(modelResult(noNews)) };
    const verify = vi.fn().mockResolvedValue([{ parts: [{ start: 0, end: source.length }], context: [] }]);
    const result = await extractWithGenerator(source, generator, { operationId: 'stage' }, vi.fn(), async () => false, verify, defaultSettings.interestProfile);
    expect(result.resolution).toBe('verified_initial');
    expect(result.events).toHaveLength(1);
    expect(verify).toHaveBeenCalledOnce();
    expect(generator.generate).toHaveBeenCalledTimes(2);
  });
  it('does not turn a non-news caption into an event when review output is malformed', async () => {
    const first = { events: [{ parts: [{ first: 'u0', last: 'u1', excerpt: null }], context: [] }], omitted: [] };
    const generator = { generate: vi.fn().mockResolvedValueOnce(modelResult(first)).mockResolvedValue(modelResult('{}{}')) };
    const judge = { judge: vi.fn().mockResolvedValue({ type: 'choice', choice: 'rejected' }) };
    const verify = vi.fn((events: Parameters<typeof confirmCandidatePartition>[1]) =>
      confirmCandidatePartition(caption, events, judge, context, defaultSettings));
    await expect(extractWithGenerator(caption, generator, { operationId: 'stage' }, vi.fn(), async () => false, verify)).rejects.toThrow();
    expect(verify).toHaveBeenCalledOnce();
    expect(judge.judge).toHaveBeenCalledOnce();
    expect(generator.generate).toHaveBeenCalledTimes(3);
  });
});
describe('repair diagnostics', () => {
  it('separates invalid JSON, schema nulls, coverage gaps and valid empty proposals', () => {
    expect(extractionDiagnostic(caption, '{}{}').kind).toBe('invalid_json');
    const invalid = extractionDiagnostic(caption, JSON.stringify({ events: [{ parts: null, context: [] }], omitted: [] }));
    expect(invalid).toMatchObject({ kind: 'schema', details: [expect.objectContaining({ code: 'invalid_type', path: ['events', 0, 'parts'] })] });
    expect(extractionDiagnostic(caption, JSON.stringify({ events: [], omitted: [] })).kind).toBe('coverage_or_coordinates');
    expect(extractionDiagnostic(caption, JSON.stringify(noNews))).toEqual({ kind: 'empty_candidate' });
  });
  it('reports valid nonempty partitions as valid, not as overlapping', () => {
    expect(extractionDiagnostic(caption, JSON.stringify({ events: [{ parts: [{ first: 'u0', last: 'u1', excerpt: null }], context: [] }], omitted: [] })))
      .toEqual({ kind: 'valid' });
  });
});
