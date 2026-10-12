import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import type { UsageCall } from './usage.js';

const manualRun = new AsyncLocalStorage<string>();
export function withManualUsage<T>(id: string, run: () => Promise<T>): Promise<T> {
  return manualRun.run(z.uuid().parse(id), run);
}
export function manualUsage(call: UsageCall): UsageCall {
  const id = manualRun.getStore();
  return id ? { ...call, operationId: `run_now:${id}:${call.operationId ?? 'model'}` } : call;
}
export function originalUsageOperation(id: string | null): string | null {
  return id?.startsWith('run_now:') ? id.split(':').slice(2).join(':') : id;
}
