import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { ModelRequestError, failureMetadata, RequestFault } from '../models/errors.js';
import { ProcessingYield } from './processing-slice.js';
import { storyWork } from './story-failures.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), boundary: vi.fn(), markers: new Map<string, unknown>() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./failure-admission.js', () => ({ failureInputBoundary: mocks.boundary, failureBoundaryFingerprint: JSON.stringify }));
vi.mock('./processing-diagnostics.js', () => ({ recordProcessingDiagnostic: vi.fn() }));
vi.mock('../publishing/updates.js', () => ({ prepareUpdates: vi.fn() }));
const id = '00000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.useFakeTimers(); mocks.markers.clear(); mocks.boundary.mockResolvedValue({ input: 'unchanged' });
  mocks.query.mockReset().mockImplementation(async (sql: string, args: string[]) => {
    if (sql.startsWith('SELECT value')) return { rows: mocks.markers.has(args[0] ?? '') ? [{ value: mocks.markers.get(args[0] ?? '') }] : [] };
    if (sql.startsWith('INSERT INTO operational_state')) mocks.markers.set(args[0] ?? '', JSON.parse(args[1] ?? 'null'));
    if (sql.startsWith('DELETE FROM operational_state')) mocks.markers.delete(args[0] ?? '');
    return { rows: [] };
  });
});
afterEach(() => vi.useRealTimers());
it.each(['pi','jev','embedding'] as const)('isolates %s failures, retries automatically and skips after N attempts', async service => {
  const error = new ModelRequestError(failureMetadata(new RequestFault('transient'), id, service, 1, 0));
  const run = vi.fn().mockRejectedValue(error);
  const settings = { ...defaultSettings, requestMaxAttempts: 2 };
  expect(await storyWork(id, settings, null, run)).toBe('failed');
  expect(await storyWork(id, settings, null, run)).toBe('skipped');
  expect(await storyWork('00000000-0000-4000-8000-000000000002', settings, null, async () => true)).toBe('completed');
  await vi.advanceTimersByTimeAsync(settings.retryBaseMs+1);
  expect(await storyWork(id, settings, null, run)).toBe('failed');
  await vi.advanceTimersByTimeAsync(settings.retryMaxMs+1);
  expect(await storyWork(id, settings, null, run)).toBe('skipped');
  expect(run).toHaveBeenCalledTimes(2);
});
it('changed collected input gets a fresh budget; success clears the failure marker', async () => {
  const settings = { ...defaultSettings, requestMaxAttempts: 1 };
  expect(await storyWork(id, settings, null, async () => { throw new Error('bad'); })).toBe('failed');
  mocks.boundary.mockResolvedValue({ input: 'new collected content' });
  expect(await storyWork(id, settings, null, async () => true)).toBe('completed');
  expect(mocks.markers.size).toBe(0);
});
it('checkpoints propagate without creating a story failure', async () => {
  await expect(storyWork(id, defaultSettings, null, async () => { throw new ProcessingYield(); })).rejects.toBeInstanceOf(ProcessingYield);
  expect(mocks.markers.size).toBe(0);
});
