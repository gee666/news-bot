import { beforeEach, expect, it, vi } from 'vitest';
import { ModelRequestError, type PiRequest } from '../models/index.js';
import { failureMetadata, RequestFault } from '../models/errors.js';
import { defaultSettings } from '../settings.js';
import { modelResult } from './generation.test-helpers.js';
import { confirmSourceLinks, type SourceConfirmationInput, type SourceVerdict } from './source-links-confirmation.js';
import { sourceConfirmationChunks } from './source-links-chunks.js';
import { sourceConfirmationRequest } from './source-links-verdicts.js';
import { sourceInputFromRequest as fromRequest, sourceWireVerdicts } from './source-links.test-helpers.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), privacy: vi.fn(), failure: vi.fn(), client: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: mocks.privacy }));
vi.mock('./generation-model.js', () => ({ generationClient: mocks.client }));
vi.mock('./state.js', async original => ({ ...await original<typeof import('./state.js')>(), recordFailure: mocks.failure }));
const context = { id: 'source-stage', revisionId: 'revision', storyId: null, batchId: null, attempt: 4 };
function input(count: number, storyChars = 100): SourceConfirmationInput {
  return { revision_id: context.revisionId, message: 'Product launch source, with complete qualification.',
    candidates: Array.from({ length: count }, (_, i) => ({ candidate_id: `candidate-${i}`, story_id: `story-${i}`,
      link_id: `link-${i}`, url: 'https://example.org/product', anchor: 'Product', story: 'Product ' + 'x'.repeat(storyChars) })) };
}
function verdicts(value: SourceConfirmationInput): SourceVerdict[] {
  return sourceConfirmationRequest(value).resolve({ items: Object.fromEntries(value.candidates.map(candidate => [candidate.candidate_id,
    { verdict: 'relevant', reason: 'Same named event.', source_excerpt_id: 'message_0', story_excerpt_id: 'story_0' }])) });
}
const generate = vi.fn();
function memoryCache(): Map<string, unknown> {
  const cache = new Map<string, unknown>();
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (!sql.startsWith('SELECT value') && !sql.startsWith('INSERT INTO model_cache')) return { rows: [] };
    const key = params[0];
    if (typeof key !== 'string') throw new Error('Missing cache key');
    if (sql.startsWith('SELECT value')) return { rows: cache.has(key) ? [{ value: cache.get(key) }] : [] };
    const json = params[3];
    if (typeof json !== 'string') throw new Error('Missing cached verdict');
    cache.set(key, JSON.parse(json)); return { rows: [] };
  });
  return cache;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.client.mockResolvedValue({ generate });
  generate.mockImplementation(async (request: PiRequest) => modelResult(sourceWireVerdicts(request, verdicts(fromRequest(request)).reverse())));
});

it('splits an aggregate above 120k into deterministic selection chunks without truncation', async () => {
  const value = input(20, 18_000);
  expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(120_000);
  const plan = sourceConfirmationChunks(value);
  expect(plan).toEqual(sourceConfirmationChunks(value));
  expect(plan.length).toBeGreaterThan(1);
  for (const chunk of plan) {
    expect(chunk.candidates.length).toBeLessThanOrEqual(10);
    expect(chunk.message).toBe(value.message);
  }
  expect(plan.flatMap(chunk => chunk.candidates)).toEqual(value.candidates);
  expect(await confirmSourceLinks(value, defaultSettings, context, { generate })).toEqual(verdicts(value));
  expect(generate.mock.calls.flatMap(([request]) => fromRequest(request).candidates)).toEqual(value.candidates);
});

it('processes more than 200 IDs exactly once and never overlaps requests', async () => {
  const value = input(205);
  let active = 0;
  let maximum = 0;
  generate.mockImplementation(async (request: PiRequest) => {
    active++; maximum = Math.max(maximum, active);
    await Promise.resolve();
    active--;
    return modelResult(sourceWireVerdicts(request, verdicts(fromRequest(request)).reverse()));
  });
  expect(await confirmSourceLinks(value, defaultSettings, context, { generate })).toEqual(verdicts(value));
  expect(generate).toHaveBeenCalledTimes(21);
  expect(maximum).toBe(1);
  expect(generate.mock.calls.flatMap(([request]) => fromRequest(request).candidates.map(candidate => candidate.candidate_id)))
    .toEqual(value.candidates.map(candidate => candidate.candidate_id));
  for (const call of generate.mock.calls) expect(call[1]).toEqual({ operationId: context.id, attempt: context.attempt });
});

it('resumes after a later chunk fails, reusing completed chunk caches by full input', async () => {
  const cache = memoryCache();
  const value = input(25);
  const error = new ModelRequestError(failureMetadata(new RequestFault('timeout'), context.id, 'pi', 4, 12_000));
  generate.mockImplementationOnce(async (request: PiRequest) => modelResult(sourceWireVerdicts(request, verdicts(fromRequest(request)).reverse())))
    .mockRejectedValueOnce(error);
  await expect(confirmSourceLinks(value, defaultSettings, context, { generate })).rejects.toBe(error);
  expect(cache.size).toBe(1);
  expect(generate).toHaveBeenCalledTimes(2);
  generate.mockClear();
  expect(await confirmSourceLinks(value, defaultSettings, { ...context, attempt: 5 }, { generate })).toEqual(verdicts(value));
  expect(generate).toHaveBeenCalledTimes(2);
  expect(fromRequest(generate.mock.calls[0]?.[0]).candidates[0]?.candidate_id).toBe('candidate-10');
  expect(cache.size).toBe(3);
  generate.mockClear();
  await confirmSourceLinks(value, defaultSettings, context, { generate });
  expect(generate).not.toHaveBeenCalled();
  // A change to full text invalidates that chunk, even beyond the beginning of the story.
  value.candidates[0]!.story += ' Full-text change.';
  await confirmSourceLinks(value, defaultSettings, context, { generate });
  expect(generate).toHaveBeenCalledOnce();
});

it('yields between fresh chunks without failure recording and resumes from the saved cache', async () => {
  const cache = memoryCache(); const value = input(25);
  const previous = process.env.PROCESSING_SLICE_MS; process.env.PROCESSING_SLICE_MS = '1000';
  let clock = 0; const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  generate.mockImplementationOnce(async (request: PiRequest) => {
    clock = 1001; return modelResult(sourceWireVerdicts(request, verdicts(fromRequest(request))));
  });
  try {
    await expect(withProcessingSlice(() => confirmSourceLinks(value, defaultSettings, context, { generate })))
      .rejects.toBeInstanceOf(ProcessingYield);
    expect(generate).toHaveBeenCalledOnce(); expect(cache.size).toBe(1); expect(mocks.failure).not.toHaveBeenCalled();
    expect(await withProcessingSlice(() => confirmSourceLinks(value, defaultSettings, context, { generate }))).toEqual(verdicts(value));
    expect(generate).toHaveBeenCalledTimes(3); expect(cache.size).toBe(3);
    await withProcessingSlice(async () => { clock += 1001; await confirmSourceLinks(value, defaultSettings, context, { generate }); });
    expect(generate).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
    if (previous === undefined) delete process.env.PROCESSING_SLICE_MS; else process.env.PROCESSING_SLICE_MS = previous;
  }
});

it('guards every story before any cache lookup, even when cached chunks exist', async () => {
  const value = input(21);
  mocks.query.mockResolvedValue({ rows: [{ value: { items: verdicts(value) } }] });
  const denied = new Error('Private source not approved');
  mocks.privacy.mockImplementation(async (_endpoint: string, _id: string, owner: { storyId: string }) => {
    if (owner.storyId === 'story-20') throw denied;
  });
  await expect(confirmSourceLinks(value, defaultSettings, context, { generate })).rejects.toBe(denied);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
  expect(mocks.client).not.toHaveBeenCalled();
});

it('passes a large indivisible candidate to Pi without a byte cap', async () => {
  const value = input(2);
  value.candidates[1]!.story = 'Product ' + 'я'.repeat(45_000);
  expect(sourceConfirmationChunks(value).flatMap(chunk=>chunk.candidates)).toEqual(value.candidates);
  expect(await confirmSourceLinks(value,defaultSettings,context,{generate})).toEqual(verdicts(value));
  expect(generate).toHaveBeenCalledOnce();
});

it('preserves singleton deadline errors, caller identity and attempt without hidden retries', async () => {
  const settings = { ...defaultSettings, piTimeoutMs: 12_000 };
  const error = new ModelRequestError(failureMetadata(new RequestFault('timeout'), context.id, 'pi', context.attempt, 12_000));
  generate.mockRejectedValue(error);
  await expect(confirmSourceLinks(input(1), settings, context)).rejects.toBe(error);
  expect(mocks.client).toHaveBeenCalledWith(settings, expect.any(Function));
  expect(generate).toHaveBeenCalledOnce();
  expect(generate.mock.calls[0]?.[1]).toEqual({ operationId: context.id, attempt: 4 });
  expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('INSERT'))).toBe(false);
});

it('does not cap structured repair input', async () => {
  generate.mockResolvedValueOnce(modelResult({ wrong: true }));
  await confirmSourceLinks(input(1,130_000),defaultSettings,context,{generate});
  expect(generate).toHaveBeenCalledTimes(2);
  expect(generate.mock.calls[1]?.[0].prompt.length).toBeGreaterThan(120_000);
});

it('rejects duplicate input IDs spanning chunks instead of silently losing results', async () => {
  const value = input(11);
  value.candidates[10]!.candidate_id = 'candidate-0';
  await expect(confirmSourceLinks(value, defaultSettings, context, { generate }))
    .rejects.toMatchObject({ metadata: { kind: 'invalid_request', outcome: 'not_submitted', attempt: 4 } });
  expect(generate).not.toHaveBeenCalled();
});
