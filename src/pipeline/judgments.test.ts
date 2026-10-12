import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { Judgments } from './judgments.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), judge: vi.fn(), privacy: vi.fn(), failure: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../models/jev.js', () => ({ JevClient: class { judge = mocks.judge; async close() {} } }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: mocks.privacy }));
vi.mock('./state.js', async original => ({ ...await original<typeof import('./state.js')>(), recordFailure: mocks.failure }));
const answer = { type: 'choice', choice: 'left', probabilities: { left: 1 }, confidence: 1 };
const context = { id: 'representative-stage', attempt: 1, batchId: null, revisionId: null, storyId: null };
let clock = 0;
beforeEach(() => {
  vi.resetAllMocks(); clock = 0;
  vi.stubEnv('PROCESSING_SLICE_MS', '1000');
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  mocks.query.mockResolvedValue({ rows: [] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('reuses a cached judgment and journals its receipt after the slice expires', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ value: answer }] });
  const judgments = new Judgments(defaultSettings);
  await withProcessingSlice(async () => {
    clock = 1001;
    expect(await judgments.judge('representative', { left: 'A', right: 'B' }, context)).toEqual(answer);
  });
  expect(mocks.judge).not.toHaveBeenCalled(); expect(mocks.failure).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[1]?.[0]).toContain('INSERT INTO judgments');
  expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
});

it('yields an uncached judgment without provider dispatch, failure or output writes', async () => {
  const judgments = new Judgments(defaultSettings);
  await expect(withProcessingSlice(async () => {
    clock = 1001; await judgments.judge('representative', { left: 'A', right: 'B' }, context);
  })).rejects.toBeInstanceOf(ProcessingYield);
  expect(mocks.judge).not.toHaveBeenCalled(); expect(mocks.privacy).not.toHaveBeenCalled();
  expect(mocks.failure).not.toHaveBeenCalled(); expect(mocks.query).toHaveBeenCalledOnce();
});

it('retains a reply that finishes past the deadline, reuses it, then yields before the next miss', async () => {
  const cache = new Map<string, unknown>();
  mocks.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
    if (sql.startsWith('SELECT value')) {
      const value = cache.get(String(args[0])); return { rows: value ? [{ value }] : [] };
    }
    if (sql.startsWith('INSERT INTO model_cache')) cache.set(String(args[0]), JSON.parse(String(args[3])));
    return { rows: [] };
  });
  mocks.judge.mockImplementation(async () => { clock = 1001; return { answers: { answer }, metrics: {}, model: 'offline' }; });
  const judgments = new Judgments(defaultSettings); const state = { left: 'A', right: 'B' };
  await expect(withProcessingSlice(async () => {
    await judgments.judge('representative', state, context);
    await judgments.judge('representative', state, context);
    await judgments.judge('representative', { ...state, right: 'C' }, context);
  })).rejects.toBeInstanceOf(ProcessingYield);
  expect(mocks.judge).toHaveBeenCalledOnce(); expect(cache.size).toBe(1); expect(mocks.failure).not.toHaveBeenCalled();
});
