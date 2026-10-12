import { afterEach, expect, it, vi } from 'vitest';
import { checkProcessingSlice, processingSliceMs, ProcessingYield, withProcessingSlice } from './processing-slice.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it('defaults to a two-minute slice and validates operational bounds', () => {
  vi.stubEnv('PROCESSING_SLICE_MS', undefined);
  expect(processingSliceMs()).toBe(120_000);
  for (const [value, expected] of [['1000', 1000], ['3600000', 3600000]] as const) {
    vi.stubEnv('PROCESSING_SLICE_MS', value); expect(processingSliceMs()).toBe(expected);
  }
});
it.each(['999', '3600001', 'not-a-number', '1000.5'])('rejects invalid slice duration %s', value => {
  vi.stubEnv('PROCESSING_SLICE_MS', value); expect(processingSliceMs).toThrow();
});
it('isolates deadlines between overlapping work and leaves unscoped digest work untouched', async () => {
  let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  let release: () => void = () => {};
  const ready = new Promise<void>(resolve => { release = resolve; });
  vi.stubEnv('PROCESSING_SLICE_MS', '1000');
  const expired = withProcessingSlice(async () => { await ready; checkProcessingSlice(); });
  const rejected = expect(expired).rejects.toBeInstanceOf(ProcessingYield);
  vi.stubEnv('PROCESSING_SLICE_MS', '2000');
  await withProcessingSlice(async () => { clock = 1500; release(); checkProcessingSlice(); });
  await rejected;
  clock = 3000;
  expect(checkProcessingSlice).not.toThrow();
});
