import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PiRequest, RequestContext } from '../models/index.js';
import { defaultSettings } from '../settings.js';
import { ModelRequestError, failureMetadata, RequestFault } from '../models/errors.js';
import { researchStory } from './generation.js';
import { previousStory, publishedStory, alreadyGenerated, saveGenerations } from './generation-store.js';
import { generationClient } from './generation-model.js';
import { evidenceDocument, modelResult, storyId, storyInput } from './generation.test-helpers.js';

const mocks = vi.hoisted(() => ({ input: vi.fn(), generate: vi.fn() }));
vi.mock('./generation-store.js', () => ({
  publishedStory:vi.fn(async()=>null),previousStory:vi.fn(async()=>null),
  loadStory: mocks.input, alreadyGenerated: vi.fn(), evidenceSnapshotHash: async () => 'evidence-signature',
  saveGenerations: vi.fn(), loadCurrentEvidence:async()=>[],
}));
vi.mock('./generation-model.js', async original => ({
  ...await original<typeof import('./generation-model.js')>(), generationClient: vi.fn(), recordGenerationFailure: vi.fn(),
}));
vi.mock('../db.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('./source-origins.js',()=>({classifySourceOrigins:async()=>[]}));
vi.mock('./research.js', async original => ({
  ...await original<typeof import('./research.js')>(), researchEvidence: async () => [evidenceDocument()],
}));
const draft = { headline: 'Acme выпустила версию 2.0', summary: 'Исправлена ошибка безопасности.',
  source_urls: ['https://example.org/release'] };
const passed = { remarks: [] };
const failed = { remarks: ['Версия не подтверждена источниками'] };
const savedPassed = { supported: true, reason: '' };
const savedFailed = { supported: false, reason: 'Версия не подтверждена источниками' };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.input.mockResolvedValue(storyInput());
  vi.mocked(alreadyGenerated).mockResolvedValue(false);
  vi.mocked(generationClient).mockResolvedValue({ generate: mocks.generate });
  mocks.generate.mockReset();
});

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('writes and reviews once, keeping all source material and links', async () => {
  const input = storyInput();
  const text = 'Подробный исходный текст. '.repeat(5000) + 'Конец материала';
  input.mentions[0]!.text = text;
  mocks.input.mockResolvedValue(input);
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId, defaultSettings);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  expect(mocks.generate.mock.calls[0]?.[0].prompt).toContain(text);
  expect(mocks.generate.mock.calls[0]?.[0].systemPrompt).toContain('НИКОГДА не называй их в тексте');
  const material=JSON.parse(mocks.generate.mock.calls[0]?.[0].prompt);
  expect(material.mentions[0]).not.toHaveProperty('source_name');
  expect(material).toHaveProperty('primary_sources');
  expect(mocks.generate.mock.calls[0]?.[1].operationId).toBe(`research:${storyId}:generate`);
  expect(mocks.generate.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  expect(mocks.generate.mock.calls[1]?.[1].signal).toBeInstanceOf(AbortSignal);
  expect(mocks.generate.mock.calls[1]?.[1].operationId).toBe(`research:${storyId}:review`);
  expect(saveGenerations).toHaveBeenCalledWith([input], [expect.objectContaining({
    id: storyId, headline: draft.headline, summary: draft.summary, sourceUrls: draft.source_urls,
    review: savedPassed, evidenceSignature: 'evidence-signature',
  })], defaultSettings);
});

it('requests only actual remarks and saves an empty reason when there are none', async () => {
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId,defaultSettings);
  const schema=mocks.generate.mock.calls[1]?.[0].responseSchema.schema;
  expect(schema).toHaveProperty('required',['remarks']);
  expect(schema).toHaveProperty(['properties','remarks','type'],'array');
  expect(saveGenerations).toHaveBeenCalledWith(expect.anything(),[expect.objectContaining({review:savedPassed})],defaultSettings);
});

it('omits unsupported URI format from the native schema without dropping other constraints', async () => {
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId, defaultSettings);
  const native = mocks.generate.mock.calls[0]?.[0].responseSchema.schema;
  expect(native).toHaveProperty(['properties', 'source_urls', 'items'], { type: 'string' });
  expect(native).not.toHaveProperty(['properties', 'source_urls', 'items', 'format']);
  expect(native).toHaveProperty(['properties', 'headline', 'pattern'], '[А-Яа-яЁё]');
  expect(native).toHaveProperty(['properties', 'summary', 'minLength'], 1);
  expect(native).toHaveProperty('additionalProperties', false);
  expect(native).toHaveProperty('required', ['headline', 'summary', 'source_urls']);
  expect(mocks.generate.mock.calls[0]?.[0].systemPrompt).toContain(JSON.stringify(native));
  expect(saveGenerations).toHaveBeenCalledOnce();
});

it.each(['ftp://example.org/release', 'javascript:alert(1)', 'not-a-url'])('still rejects invalid source URL %s locally', async url => {
  mocks.generate.mockResolvedValueOnce(modelResult({ ...draft, source_urls: [url] }));
  await expect(researchStory(storyId, defaultSettings)).rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(saveGenerations).not.toHaveBeenCalled();
});

it('saves a still-unsupported rewrite after exactly one rewrite and re-review', async () => {
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(failed))
    .mockResolvedValueOnce(modelResult({ ...draft, summary: 'Acme сообщила об обновлении.' }))
    .mockResolvedValueOnce(modelResult({ remarks: ['Версия не подтверждена\nисточниками'] }));
  await researchStory(storyId, defaultSettings);
  expect(mocks.generate).toHaveBeenCalledTimes(4);
  expect(saveGenerations).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
    summary: 'Acme сообщила об обновлении.', review: savedFailed,
  })], defaultSettings);
});

it('does not reject long output or add a structured repair call', async () => {
  mocks.generate.mockResolvedValueOnce(modelResult({ ...draft, summary: 'Подробности. '.repeat(500) }))
    .mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId, defaultSettings);
  expect(saveGenerations).toHaveBeenCalledOnce();
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it('fails malformed output after one call without saving a notice', async () => {
  mocks.generate.mockResolvedValueOnce(modelResult('not JSON'));
  await expect(researchStory(storyId, defaultSettings)).rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
  expect(mocks.generate).toHaveBeenCalledOnce();
  expect(saveGenerations).not.toHaveBeenCalled();
});

it('leaves a Pi failure for the per-story retry instead of marking a notice as success', async () => {
  const error = new ModelRequestError(failureMetadata(new RequestFault('transient'), `research:${storyId}`, 'pi', 1, 0));
  mocks.generate.mockRejectedValueOnce(error);
  await expect(researchStory(storyId, defaultSettings)).rejects.toBe(error);
  expect(saveGenerations).not.toHaveBeenCalled();
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId, defaultSettings);
  expect(saveGenerations).toHaveBeenCalledOnce();
});

it.each(['review', 'rewrite', 're-review'] as const)('saves the last valid draft with a warning when %s fails', async phase => {
  const revised = { ...draft, summary: 'Acme сообщила об обновлении.' };
  const error = new ModelRequestError(failureMetadata(new RequestFault('transient'), `research:${storyId}:${phase}`, 'pi', 1, 0));
  mocks.generate.mockResolvedValueOnce(modelResult(draft));
  if (phase !== 'review') mocks.generate.mockResolvedValueOnce(modelResult(failed));
  if (phase === 're-review') mocks.generate.mockResolvedValueOnce(modelResult(revised));
  mocks.generate.mockRejectedValueOnce(error);
  await researchStory(storyId, defaultSettings);
  expect(saveGenerations).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
    summary: phase === 're-review' ? revised.summary : draft.summary,
    review: { supported: false, reason: 'Проверка не завершена: сервис модели не вернул корректный ответ' },
  })], defaultSettings);
  expect(mocks.generate).toHaveBeenCalledTimes(phase === 'review' ? 2 : phase === 'rewrite' ? 3 : 4);
});

it.each(['review', 'rewrite', 're-review'] as const)('aborts a stalled optional %s at the slice timeout and saves the last valid draft', async phase => {
  vi.stubEnv('PROCESSING_SLICE_MS', '1000');
  const revised = { ...draft, summary: 'Acme сообщила об обновлении.' };
  mocks.generate.mockResolvedValueOnce(modelResult(draft));
  if (phase !== 'review') mocks.generate.mockResolvedValueOnce(modelResult(failed));
  if (phase === 're-review') mocks.generate.mockResolvedValueOnce(modelResult(revised));
  let aborted = false;
  mocks.generate.mockImplementationOnce((_request: PiRequest, context: RequestContext) => new Promise((_resolve, reject) => {
    const signal = context.signal;
    if (!signal) { reject(new Error('Missing optional deadline')); return; }
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new ModelRequestError(failureMetadata(new RequestFault('cancelled'), context.operationId, 'pi', 1, 1000)));
    }, { once: true });
  }));
  await researchStory(storyId, { ...defaultSettings, piTimeoutMs: 1_200_000 });
  expect(aborted).toBe(true);
  expect(mocks.generate.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  for (const [, context] of mocks.generate.mock.calls.slice(1)) expect(context.signal).toBeInstanceOf(AbortSignal);
  expect(saveGenerations).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
    summary: phase==='re-review' ? revised.summary : draft.summary,
    review: expect.objectContaining({ supported: false }),
  })], expect.anything());
  expect(mocks.generate).toHaveBeenCalledTimes(phase==='review' ? 2 : phase==='rewrite' ? 3 : 4);
});

it('saves a valid draft with a warning when review JSON is malformed', async () => {
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult('not JSON'));
  await researchStory(storyId, defaultSettings);
  expect(saveGenerations).toHaveBeenCalledWith(expect.anything(), [expect.objectContaining({
    summary: draft.summary, review: expect.objectContaining({ supported: false }),
  })], defaultSettings);
  expect(mocks.generate).toHaveBeenCalledTimes(2);
});

it('does not swallow infrastructure errors after writing a draft', async () => {
  const error = new Error('Database unavailable');
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockRejectedValueOnce(error);
  await expect(researchStory(storyId, defaultSettings)).rejects.toBe(error);
  expect(saveGenerations).not.toHaveBeenCalled();
});

it('regenerates a notice instead of retaining its text', async () => {
  const input = storyInput();
  input.story.headline = 'Материалы по новости'; input.story.summary = 'Краткий пересказ недоступен';
  input.story.researched = true;
  mocks.input.mockResolvedValue(input);
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId, defaultSettings);
  expect(saveGenerations).toHaveBeenCalledWith([input], [expect.objectContaining({ summary: draft.summary })], defaultSettings);
});

it('skips an already generated story without buying another review', async () => {
  vi.mocked(alreadyGenerated).mockResolvedValue(true);
  await researchStory(storyId, defaultSettings);
  expect(mocks.generate).not.toHaveBeenCalled();
});

it('passes the posted copy to a follow-up writer and tells it to cover only new information', async () => {
  vi.mocked(previousStory).mockResolvedValueOnce({storyId:'previous',headline:'Предыдущий заголовок',summary:'Старые сведения',destinationId:'-100123',messageId:'644'});
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId,defaultSettings);
  const request=mocks.generate.mock.calls[0]?.[0];
  expect(JSON.parse(request.prompt).previous_post).toEqual({headline:'Предыдущий заголовок',summary:'Старые сведения'});
  expect(request.systemPrompt).toContain('не пересказывай предыдущую публикацию');
});

it('never regenerates a published story, even when forced', async () => {
  vi.mocked(publishedStory).mockResolvedValueOnce({storyId,headline:'Уже опубликовано',summary:'Сведения',destinationId:'-100123',messageId:'644'});
  await researchStory(storyId,defaultSettings,true);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(mocks.input).not.toHaveBeenCalled();
});
