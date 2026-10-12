import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { confirmNoNews } from './extraction.js';
import { extractWithGenerator } from './extraction-fallback.js';
import { sourceUnits, sourceSelectionSchema, selectedEvents } from './extraction-boundaries.js';
import { modelResult } from './generation.test-helpers.js';

const context = { id: 'review-stage', attempt: 1, batchId: null, revisionId: null, storyId: null };
const news = [
  'Researchers found that Russian prompts use more tokens than English prompts in their tests.',
  'Flowsint introduced a new local investigation mode.',
  'Clothing sellers switched to AI-generated product cards after a new marketplace requirement.',
  'A new MCP version is expected tomorrow, according to its maintainers.',
  'Compiler A was released. Buy our unrelated course to learn programming.',
];

it.each(news)('keeps admitted findings, introductions, adoption changes, previews and mixed news failed rather than accepting empty output: %s', async text => {
  const units = sourceUnits(text);
  const last = units.at(-1)?.id;
  if (!last) throw new Error('Missing fixture units');
  const generate = vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [
    { id: units[0]?.id, last, excerpt: null, reason: 'non_news' },
  ] }));
  const judge = { judge: vi.fn().mockResolvedValueOnce({ type: 'choice', choice: 'eligible' })
    .mockResolvedValueOnce({ type: 'choice', choice: 'extractable' }) };
  const settings = { ...defaultSettings, interestProfile: 'Keep developments and findings. Exclude instructional material, not low-interest news.' };
  const record = vi.fn();
  await expect(extractWithGenerator(text, { supportsNativeSchema: true, generate }, { operationId: context.id }, record,
    () => confirmNoNews(text, judge, context, settings), undefined, settings.interestProfile)).rejects.toMatchObject({
    metadata: { kind: 'invalid_output', outcome: 'rejected', retryable: false,
      validation: { codes: ['empty_extraction_unconfirmed'] } },
  });
  expect(judge.judge).toHaveBeenLastCalledWith('extraction_admission', { message: { text }, interestProfile: settings.interestProfile }, context);
  expect(generate).toHaveBeenCalledTimes(2);
  expect(record).toHaveBeenCalledOnce();
});

it.each(['first', 'last', 'context', 'omitted_last'] as const)('rejects unknown review %s IDs when the known initial partition cannot be independently admitted', async field => {
  const text = 'The government announced smart-glasses restrictions.\nThe rules apply in government offices.';
  const complete = { events: [{ parts: [{ first: 'u0', last: 'u1', excerpt: null }], context: [] }], omitted: [] };
  const invalid = field === 'omitted_last' ? { events: [], omitted: [{ id: 'u0', last: 'u999', excerpt: null, reason: 'non_news' }] }
    : { events: [{ parts: [{ first: field === 'first' ? 'u999' : 'u0', last: field === 'last' ? 'u999' : 'u1', excerpt: null }],
      context: field === 'context' ? [{ first: 'u999', last: 'u999', excerpt: null }] : [] }], omitted: [] };
  const generate = vi.fn().mockResolvedValueOnce(modelResult(complete)).mockResolvedValue(modelResult(invalid));
  const confirmEmpty = vi.fn().mockResolvedValue(true);
  const confirmCandidates = vi.fn().mockResolvedValue(false);
  const record = vi.fn();
  await expect(extractWithGenerator(text, { supportsNativeSchema: true, generate }, { operationId: context.id }, record,
    confirmEmpty, confirmCandidates)).rejects.toMatchObject({ metadata: { kind: 'invalid_output', retryable: false,
    validation: { codes: ['schema'] } } });
  expect(generate).toHaveBeenCalledTimes(3);
  expect(generate.mock.calls[2]?.[1].operationId).toBe(`${context.id}:review:repair`);
  expect(confirmEmpty).not.toHaveBeenCalled();
  expect(confirmCandidates).toHaveBeenCalledWith([{ parts: [{ start: 0, end: text.length }], context: [] }]);
  for (const [request] of generate.mock.calls) {
    expect(request.responseSchema).toBeDefined();
    expect(request.systemPrompt).not.toContain('JSON schema:');
  }
});

it.each(['```json\n{}\n```', '{"events":[]} {"omitted":[]}', '{"events":[],'])('does not salvage malformed provider output or use admission to excuse it', async response => {
  const generate = vi.fn().mockResolvedValue(modelResult(response));
  const confirmEmpty = vi.fn().mockResolvedValue(true);
  await expect(extractWithGenerator('OpenAI announced watermarking.', { supportsNativeSchema: true, generate },
    { operationId: context.id }, vi.fn(), confirmEmpty)).rejects.toMatchObject({ metadata: {
    kind: 'invalid_output', validation: { codes: ['json'] },
  } });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(confirmEmpty).not.toHaveBeenCalled();
});

it('keeps lossless Unicode coordinates and strict word coverage in the constrained contract', () => {
  const text = '\tSkoltech представил шесть работ EMNLP.\r\n🙂 Модель сохраняет русский текст.\nЦена не подтверждена.';
  const units = sourceUnits(text);
  const first = units[0]?.id;
  const last = units.at(-1)?.id;
  if (!first || !last) throw new Error('Missing fixture units');
  const complete = { events: [{ parts: [{ first, last, excerpt: null }], context: [] }], omitted: [] };
  expect(sourceSelectionSchema(units).safeParse(complete).success).toBe(true);
  expect(selectedEvents(text, units, complete)).toEqual([{ parts: [{ start: 1, end: text.length }], context: [] }]);
  expect(selectedEvents(text, units, { ...complete, events: [{ parts: [{ first, last: first, excerpt: null }], context: [] }] })).toBeNull();
});
