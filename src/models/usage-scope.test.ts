import { expect, it, vi } from 'vitest';
import { withManualUsage, originalUsageOperation } from './usage-scope.js';
import { deliverUsage } from './usage-delivery.js';
import type { UsageCall } from './usage.js';

it('attributes model usage to the manual run without changing stage receipt IDs or unrelated work', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const stage = '22222222-2222-4222-8222-222222222222';
  const call: UsageCall = { id, timestamp: '2026-10-01T00:00:00.000Z', provider: 'jev', model: 'local', operationId: stage,
    stage: 'interest', attempt: 1, outcome: 'completed', usageKnown: false, inputTokens: null, outputTokens: null,
    cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, estimatedCost: null, actualBilledCost: null, durationMs: 1 };
  const record = vi.fn<(call: UsageCall) => Promise<void>>(async () => {});
  await Promise.all([withManualUsage(id, () => deliverUsage(call, { record })), deliverUsage(call, { record })]);
  expect(record).toHaveBeenCalledWith({ ...call, operationId: `run_now:${id}:${stage}` });
  expect(record).toHaveBeenCalledWith(call);
  expect(originalUsageOperation(`run_now:${id}:${stage}:retry`)).toBe(`${stage}:retry`);
  expect(originalUsageOperation(stage)).toBe(stage);
});
