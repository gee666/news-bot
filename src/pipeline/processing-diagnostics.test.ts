import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelRequestError, RequestFault, failureMetadata } from '../models/errors.js';
const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
import { processingDiagnostic, recordProcessingDiagnostic } from './processing-diagnostics.js';
const id = '00000000-0000-4000-8000-000000000001';
const secret = 'PRIVATE_TOKEN_AND_SOURCE_TEXT';
beforeEach(() => { mocks.query.mockReset().mockResolvedValue({ rows: [] }); });

it('maps only exact local invariants and emits known source locations without messages or function names', () => {
  const error = new Error('Evidence changed during generation');
  error.stack = `Error: ${secret}\n    at ${secret} (file:///app/dist/pipeline/generation-store.js:154:7)\n    at /app/src/pipeline/${secret}.ts:2:1\n    at /app/node_modules/${secret}/index.js:4:2\n    at /app/src/publishing/store.ts:20:3`;
  expect(processingDiagnostic(error)).toMatchObject({ code: 'evidence_changed_during_generation', errorName: 'Error',
    frames: [{ file: 'dist/pipeline/generation-store.js', line: 154, column: 7 }, { file: 'src/publishing/store.ts', line: 20, column: 3 }] });
  expect(JSON.stringify(processingDiagnostic(error))).not.toContain(secret);
  expect(processingDiagnostic(new Error(`Evidence changed during generation ${secret}`)).code).toBe('pipeline_failed');
});
it('recognizes the existing completion invariant without serializing its message', async () => {
  const { StoryCompletionError } = await import('./state.js');
  const error = new StoryCompletionError(id, { generationCurrent: true, eligibilityCurrent: true,
    rankingCurrent: false, representativePresent: true, headlinePresent: true, unblocked: true });
  expect(processingDiagnostic(error).code).toBe('story_completion_invariant');
  expect(JSON.stringify(processingDiagnostic(error))).not.toContain(id);
});
it('rejects arbitrary names, SQL codes, constraints and first-line stack locations', () => {
  const error = Object.assign(new Error(secret), { name: secret, code: secret, constraint: secret });
  error.stack = 'Error: /app/src/pipeline/stories.ts:1:2';
  const diagnostic = processingDiagnostic(error);
  expect(diagnostic).toMatchObject({ code: 'pipeline_failed', errorName: 'UnknownError', frames: [] });
  expect(diagnostic.sqlState).toBeUndefined(); expect(diagnostic.constraint).toBeUndefined();
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(processingDiagnostic(Object.assign(new Error(secret), { code: '23505', constraint: 'one_active_batch' })))
    .toMatchObject({ sqlState: '23505', constraint: 'one_active_batch' });
});
it('keeps Zod codes and known paths, never issue messages, values, unknown keys or path tokens', () => {
  const error = new z.ZodError([{ code: 'custom', path: ['facts', 123, secret, 'sourceId'], message: secret }]);
  expect(processingDiagnostic(error).issues).toEqual([{ code: 'custom', path: ['facts', '[]', '<redacted>', 'sourceId'] }]);
  const parsed = z.object({ headline: z.number() }).strict().safeParse({ headline: secret, [secret]: secret });
  if (parsed.success) throw new Error('Expected validation failure');
  expect(JSON.stringify(processingDiagnostic(parsed.error))).not.toContain(secret);
});
it('sanitizes context and persists only internal metadata', async () => {
  await recordProcessingDiagnostic(new Error(secret), { scope: 'stage', stageId: id, batchId: secret,
    storyId: secret, revisionId: secret, task: secret, operation: secret });
  expect(mocks.query.mock.calls[0]?.[1]?.[0]).toBe(`pipeline_error:stage:${id}`);
  const saved: unknown = JSON.parse(String(mocks.query.mock.calls[0]?.[1]?.[1]));
  expect(saved).toMatchObject({ context: { stageId: id, batchId: null, storyId: null, revisionId: null } });
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(secret);
});
it('does not duplicate ModelRequestError diagnostics or let storage/getter failures mask processing', async () => {
  await recordProcessingDiagnostic(new ModelRequestError(failureMetadata(new RequestFault('transient'), id, 'pi', 1, 0)), { scope: 'batch', batchId: id });
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.query.mockRejectedValue(new Error(secret));
  const error = new Error(secret);
  Object.defineProperty(error, 'stack', { get() { throw new Error(secret); } });
  Object.defineProperty(error, 'name', { get() { throw new Error(secret); } });
  await expect(recordProcessingDiagnostic(error, { scope: 'batch', batchId: id })).resolves.toBeUndefined();
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(secret);
});
