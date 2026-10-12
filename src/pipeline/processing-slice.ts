import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';

const deadline = new AsyncLocalStorage<number>();
export class ProcessingYield extends Error {
  constructor() { super('Processing slice reached its next stage checkpoint.'); this.name = 'ProcessingYield'; }
}
export function processingSliceMs(): number {
  return z.coerce.number().int().min(1_000).max(3_600_000).parse(process.env.PROCESSING_SLICE_MS ?? 120_000);
}
export function withProcessingSlice<T>(run: () => Promise<T>): Promise<T> {
  return deadline.run(performance.now() + processingSliceMs(), run);
}

/** Check only before new stage dispatch. Never cancel requests or block completed receipt reuse. */
export function checkProcessingSlice(): void {
  const until = deadline.getStore();
  if (until !== undefined && performance.now() >= until) throw new ProcessingYield();
}
