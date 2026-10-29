import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defaultSettings } from '../settings.js';
import { ModelRequestError, failureMetadata, RequestFault } from '../models/errors.js';
import { FailedStageError, retryDecision, stage, Waiting } from './state.js';
import { ProcessingYield, processingSliceMs, withProcessingSlice } from './processing-slice.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./processing-diagnostics.js', () => ({ recordProcessingDiagnostic: vi.fn() }));
const id = '00000000-0000-4000-8000-000000000001';
const saved = (patch = {}) => ({ id, status: 'pending', attempts: 0, output: null, next_retry_at: null, ...patch });
beforeEach(() => mocks.query.mockReset().mockResolvedValue({ rows: [] }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('reuses completed empty output even when the processing slice expired', async () => {
  vi.stubEnv('PROCESSING_SLICE_MS', '1000');
  let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [saved({ status: 'completed', output: [] })] });
  const run = vi.fn();
  await withProcessingSlice(async () => {
    clock = 1001;
    expect(await stage(id, { revisionId: id }, 'extract', defaultSettings, z.array(z.string()), run)).toEqual([]);
  });
  expect(run).not.toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledTimes(2);
});
it('successful dispatches do not spend failure attempts', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [saved({ attempts: 2 })] });
  await stage(id, { revisionId: id }, 'links', defaultSettings, z.boolean(), async () => true);
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain('attempts=attempts+1');
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("status='completed'");
});
it('a checkpoint is not a failure', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [saved()] });
  await expect(stage(id, { revisionId: id }, 'count', defaultSettings, z.boolean(), async () => {
    throw new ProcessingYield();
  })).rejects.toBeInstanceOf(ProcessingYield);
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain('attempts=attempts+1');
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain("status='waiting'");
  expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([id, Math.max(defaultSettings.retryBaseMs, processingSliceMs())]);
});
it.each(['pi','jev','embedding'] as const)('automatically backs off %s failures and stops after N failures', async service => {
  const error = new ModelRequestError(failureMetadata(new RequestFault('transient'), id, service, 1, 0));
  const first = retryDecision(error, 1, defaultSettings);
  const second = retryDecision(error, 2, defaultSettings);
  expect(first.next?.getTime()).toBeGreaterThanOrEqual(Date.now()+defaultSettings.retryBaseMs-10);
  expect(second.next?.getTime()).toBeGreaterThanOrEqual(Date.now()+2*defaultSettings.retryBaseMs-10);
  expect(retryDecision(error, defaultSettings.requestMaxAttempts, defaultSettings).next).toBeNull();
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [saved()] });
  await expect(stage(id, { revisionId: id }, 'extract', defaultSettings, z.boolean(), async () => { throw error; })).rejects.toBe(error);
  expect(mocks.query.mock.calls.at(-1)?.[0]).toContain('attempts=attempts+1');
  expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE processing_batches'))).toBe(false);
});
it.each(['waiting','failed'])('does not redispatch a %s stage', async status => {
  mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [saved({ status,
    next_retry_at: status==='waiting' ? new Date(Date.now()+60_000) : null })] });
  const run = vi.fn();
  await expect(stage(id, { revisionId: id }, 'extract', defaultSettings, z.boolean(), run))
    .rejects.toBeInstanceOf(status==='waiting' ? Waiting : FailedStageError);
  expect(run).not.toHaveBeenCalled();
});
it('validation and throttling use the same bounded budget as transport failures', () => {
  for (const kind of ['invalid_output','throttled'] as const) {
    const error = new ModelRequestError(failureMetadata(new RequestFault(kind), id, 'pi', 1, 0));
    expect(retryDecision(error, 1, defaultSettings).next).not.toBeNull();
    expect(retryDecision(error, defaultSettings.requestMaxAttempts, defaultSettings).next).toBeNull();
  }
});

it.each(['authentication','invalid_request','model_unavailable','context_limit','cancelled','unknown'] as const)('does not retry permanent %s failures', kind => {
  const error=new ModelRequestError(failureMetadata(new RequestFault(kind),id,'jev',1,0));
  expect(retryDecision(error,1,defaultSettings).next).toBeNull();
});
