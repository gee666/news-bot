import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defaultSettings } from '../settings.js';
import { jevTemplates } from '../models/templates.js';
import { confirmNoNews } from './extraction.js';
import { extractWithGenerator } from './extraction-fallback.js';
import { sourceUnits, sourceSelectionSchema, selectedEvents, selectionValidationCodes, type EventSelection } from './extraction-boundaries.js';
import { modelResult } from './generation.test-helpers.js';

const text = 'OpenAI introduces opt-in text watermarking.\nDetection can produce false positives.';
const complete: EventSelection = { events: [{ parts: [{ first: 'u0', last: 'u1', excerpt: null }], context: [] }], omitted: [] };
const context = { id: 'stage', attempt: 1, batchId: null, revisionId: null, storyId: null };

it('forwards native-schema capability through the extraction wrapper and sends shared coordinate definitions once', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult(complete));
  await extractWithGenerator(text, { supportsNativeSchema: true, generate }, { operationId: 'stage' }, vi.fn());
  expect(generate).toHaveBeenCalledTimes(2);
  for (const [request] of generate.mock.calls) {
    expect(request.systemPrompt).not.toContain('JSON schema:');
    expect(JSON.stringify(request.responseSchema.schema).match(/"u0"/gu)).toHaveLength(1);
    expect(request.prompt).toContain('Detection can produce false positives.');
  }
});
it('keeps schema instructions for providers without native support', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult(complete));
  await extractWithGenerator(text, { supportsNativeSchema: false, generate }, { operationId: 'stage' }, vi.fn());
  expect(generate.mock.calls[0]?.[0].systemPrompt).toContain('JSON schema:');
});
it.each(['parts', 'context', 'omitted'] as const)('rejects invented %s coordinates in the wire contract', field => {
  const value = field === 'omitted' ? { events: [], omitted: [{ id: 'u999', last: null, excerpt: null, reason: 'non_news' }] }
    : { events: [{ parts: [{ first: field === 'parts' ? 'u999' : 'u0', last: 'u1', excerpt: null }],
      context: field === 'context' ? [{ first: 'u999', last: 'u999', excerpt: null }] : [] }], omitted: [] };
  expect(sourceSelectionSchema(sourceUnits(text)).safeParse(value).success).toBe(false);
});
it('bounds coordinates without enum overflow or truncated input for a large source', () => {
  const source = Array.from({ length: 1001 }, (_, i) => `Report ${i}.`).join('\n');
  const units = sourceUnits(source);
  const validator = sourceSelectionSchema(units);
  const value = { events: [{ parts: [{ first: 'u0', last: 'u1000', excerpt: null }], context: [] }], omitted: [] };
  expect(validator.safeParse(value).success).toBe(true);
  expect(selectedEvents(source, units, value)?.[0]?.parts).toEqual([{ start: 0, end: source.length }]);
  expect(validator.safeParse({ ...value, omitted: [{ id: 'u1001', last: null, excerpt: null, reason: 'non_news' }] }).success).toBe(false);
  expect(JSON.stringify(z.toJSONSchema(validator, { reused: 'ref' }))).not.toContain('"enum":["u0"');
});
it('allows only empty arrays when no source coordinates exist', () => {
  const validator = sourceSelectionSchema([]);
  expect(validator.safeParse({ events: [], omitted: [] }).success).toBe(true);
  expect(validator.safeParse(complete).success).toBe(false);
  expect(JSON.stringify(z.toJSONSchema(validator))).not.toContain('"enum":[]');
});
it('retains exact quotation, ordered bounds, non-overlap and exhaustive coverage checks', () => {
  const units = sourceUnits(text);
  for (const excerpt of ['invented', 'OpenAI introduces']) {
    const value = { events: [{ parts: [{ first: 'u0', last: 'u1', excerpt }], context: [] }], omitted: [] };
    expect(sourceSelectionSchema(units).safeParse(value).success).toBe(true);
    expect(selectedEvents(text, units, value)).toBeNull();
  }
  const backwards = { events: [{ parts: [{ first: 'u1', last: 'u0', excerpt: null }], context: [] }], omitted: [] };
  expect(selectedEvents(text, units, backwards)).toBeNull();
  expect(selectionValidationCodes(text, units, backwards)).toEqual(['extraction_anchor']);
  expect(selectionValidationCodes(text, units, complete)).toEqual([]);
});
it('keeps malformed JSON upstream replies terminal after one repair', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult('{}{}'));
  const record = vi.fn();
  await expect(extractWithGenerator(text, { supportsNativeSchema: true, generate }, { operationId: 'stage' }, record))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_output', outcome: 'rejected', validation: { codes: ['json'] } } });
  expect(generate).toHaveBeenCalledTimes(2);
});
it('records a coverage failure without storing source excerpts in diagnostics', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult({ events: [{ parts: [{ first: 'u0', last: 'u0', excerpt: null }], context: [] }], omitted: [] }));
  const record = vi.fn();
  await expect(extractWithGenerator(text, { generate }, { operationId: 'stage' }, record)).rejects.toMatchObject({
    metadata: { validation: { codes: ['extraction_coverage'], fields: [] } },
  });
  expect(JSON.stringify(record.mock.calls[0]?.[0].validation)).not.toContain('OpenAI');
  expect(generate.mock.calls[1]?.[0].prompt).toContain('Uncovered source text:');
});

const nonNewsCases = [
  ['image-dependent token comparison', 'Русский язык обходится в ИИ дороже английского.\nНа картинке можете увидеть разницу в расходе токенов.'],
  ['orphaned mod reaction', 'Бывшему разработчику Maxis зашел мод – придется выкладывать:\nhttps://github.com/DenisSergeevitch/simcity3000-gta-mode'],
  ['evergreen project description', 'Flowsint — это современная платформа для визуальных расследований на основе графов.\nLang: TypeScript'],
  ['general ongoing adoption', 'Селлеры одежды на маркетплейсах продолжают осваивать ИИ для создания карточек.\ntg / max'],
  ['protocol explainer', 'MCP (Model Context Protocol) это общий разъём, через который ИИ-агент подключается к сервисам.\nПроверь, есть ли у нужного сервиса MCP-подключение.'],
] as const;
it.each(nonNewsCases)('passes the same profile to independent admission for %s', async (_name, source) => {
  const settings = { ...defaultSettings, interestProfile: 'Keep real software releases. Exclude tutorials, generic advice and non-tech entertainment.' };
  const judge = { judge: vi.fn().mockResolvedValueOnce({ type: 'choice', choice: 'eligible' })
    .mockResolvedValueOnce({ type: 'choice', choice: 'not_extractable' }) };
  const last = sourceUnits(source).at(-1)?.id;
  if (!last) throw new Error('Missing fixture units');
  const generate = vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [{ id: 'u0', last, excerpt: null, reason: 'non_news' }] }));
  const result = await extractWithGenerator(source, { generate }, { operationId: 'stage' }, vi.fn(),
    () => confirmNoNews(source, judge, context, settings), undefined, settings.interestProfile);
  expect(result.resolution).toBe('confirmed_empty');
  expect(judge.judge).toHaveBeenLastCalledWith('extraction_admission', { message: { text: source }, interestProfile: settings.interestProfile }, context);
  expect(generate).toHaveBeenCalledTimes(2);
});
it('never discards an admitted brief forecast or recap to resolve model disagreement', async () => {
  const source = 'Expected Compiler A release tomorrow.\nCompiler B also updated.';
  const generate = vi.fn().mockResolvedValue(modelResult({ events: [], omitted: [{ id: 'u0', last: 'u1', excerpt: null, reason: 'non_news' }] }));
  const judge = { judge: vi.fn().mockResolvedValueOnce({ type: 'choice', choice: 'eligible' })
    .mockResolvedValueOnce({ type: 'choice', choice: 'extractable' }) };
  const record = vi.fn();
  await expect(extractWithGenerator(source, { generate }, { operationId: 'stage' }, record,
    () => confirmNoNews(source, judge, context, defaultSettings))).rejects.toMatchObject({ metadata: {
    kind: 'invalid_output', outcome: 'rejected', validation: { codes: ['empty_extraction_unconfirmed'] },
  } });
  expect(generate).toHaveBeenCalledTimes(2);
});
it.each(['eligibility', 'admission'] as const)('does not interpret an unexpected %s label as permission to discard news', async phase => {
  const judge = { judge: vi.fn().mockResolvedValueOnce({ type: 'choice', choice: phase === 'eligibility' ? 'unexpected' : 'eligible' })
    .mockResolvedValueOnce({ type: 'choice', choice: 'unexpected' }) };
  await expect(confirmNoNews(text, judge, context, defaultSettings)).rejects.toThrow();
});
it('aligns the independent admission policy with current developments and profile exclusions, not topic identification', () => {
  const admission = jevTemplates.extraction_admission;
  expect(admission.version).toBe('extraction-admission-v2');
  expect(admission.questions.admission.instructions).toContain('Require BOTH a supplied reportable development and eligibility under that same profile');
  expect(admission.questions.admission.instructions).toContain('Identifying a product or technology alone is not a development');
  expect(admission.questions.admission.instructions).toContain('A title reporting an expected launch can be enough');
});
