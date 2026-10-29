import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { infer, type Dispatch } from './inference.js';
import { RequestFault } from './errors.js';
import { codexUsage, operationStage, sdkUsage, type UsageCall } from './usage.js';
import { retryUsageWrites } from './usage-delivery.js';

const directories: string[] = [];
beforeEach(()=>vi.useFakeTimers({toFake:['Date']}));
afterEach(async () => {
  vi.useRealTimers();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function outbox(): Promise<string> {
  const path = await mkdtemp(resolve('tmp/usage-inference-'));
  directories.push(path);
  return path;
}

const usage = { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17,
  estimatedCost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } };
const context = { operationId: 'research:00000000-0000-4000-8000-000000000001:queries', attempt: 2 };

describe('per-call accounting boundary', () => {
  it('counts completed calls before output validation and never copies estimated into billed cost', async () => {
    const recordUsage = vi.fn(async () => {});
    const recordFailure = vi.fn(async () => {});
    await expect(infer('pi', 1000, context, recordFailure, async dispatch => {
      dispatch.submitted();
      dispatch.completed(usage, 'resolved-model');
      throw new RequestFault('invalid_output');
    }, 5, { provider: 'openai-codex', model: 'alias', recordUsage })).rejects.toMatchObject({
      metadata: { kind: 'invalid_output' },
    });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'completed', usageKnown: true, inputTokens: 10, outputTokens: 4,
      cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 17, estimatedCost: usage.estimatedCost,
      actualBilledCost: null, provider: 'openai-codex', model: 'resolved-model', stage: 'research:queries', attempt: 2,
    }));
  });

  it('does not count preflight failures or app results returned without dispatch', async () => {
    const recordUsage = vi.fn(async () => {});
    const accounting = { provider: 'ollama', model: 'local', recordUsage };
    await expect(infer('embedding', 1000, context, async () => {}, async () => {
      throw new RequestFault('invalid_request', { outcome: 'not_submitted' });
    }, 5, accounting)).rejects.toBeDefined();
    expect(await infer('embedding', 1000, context, async () => {}, async () => 'cached', 5, accounting)).toBe('cached');
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('leaves failed transport usage unknown instead of inserting zero tokens or costs', async () => {
    const recordUsage = vi.fn(async () => {});
    await expect(infer('pi', 1000, context, async () => {}, async dispatch => {
      dispatch.submitted(); throw new RequestFault('transient');
    }, 5, { provider: 'openai-codex', model: 'm', recordUsage })).rejects.toBeDefined();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'failed', usageKnown: false, inputTokens: null, outputTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, estimatedCost: null, actualBilledCost: null,
    }));
  });

  it('assigns a new call identity to a genuine repeat of the same operation and attempt', async () => {
    const ids: string[] = [];
    const accounting = { provider: 'jev', model: 'm', recordUsage: async (call: { id: string }) => { ids.push(call.id); } };
    const execute = async (dispatch: Dispatch) => {
      dispatch.submitted(); dispatch.completed(usage); return 'ok';
    };
    await infer('jev', 1000, context, async () => {}, execute, 5, accounting);
    await infer('jev', 1000, context, async () => {}, execute, 5, accounting);
    expect(new Set(ids).size).toBe(2);
  });

  it('validates SDK usage and does not add reasoning tokens to output again', () => {
    expect(sdkUsage({ ...usage, reasoning: 3, cost: usage.estimatedCost })).toEqual(usage);
    expect(sdkUsage({ ...usage, input: -1 })).toBeUndefined();
    expect(codexUsage({ response: { usage: { input_tokens: 13, output_tokens: 4, total_tokens: 17,
      input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } } } })).toEqual({
      input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17,
    });
    expect(operationStage(context.operationId + ':repair')).toBe('research:queries:repair');
  });

  it('retains a successful result and retries storage with the same call ID, never inference', async () => {
    const directory = await outbox();
    const recordFailure = vi.fn(async () => {});
    const report = vi.fn();
    const write = vi.fn<(_: UsageCall) => Promise<void>>()
      .mockRejectedValueOnce(new Error('PRIVATE_DATABASE_ERROR')).mockResolvedValue(undefined);
    const execute = vi.fn(async (dispatch: Dispatch) => { dispatch.submitted(); dispatch.completed(usage); return 'ok'; });
    await expect(infer('pi', 1000, context, recordFailure, execute, 5, {
      provider: 'openai-codex', model: 'm', recordUsage: write, usageOutboxDirectory: directory, reportUsageFailure: report,
    })).resolves.toBe('ok');
    const call = write.mock.calls[0]?.[0];
    expect(report).toHaveBeenCalledWith(call?.id, 'database_write');
    vi.setSystemTime(Date.now()+30_001);
    expect(await retryUsageWrites({ directory, record: write, report })).toBe(1);
    expect(write.mock.calls[1]?.[0]).toEqual(call);
    expect(await readdir(directory)).toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
    expect(recordFailure).not.toHaveBeenCalled();
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE_');
  });

  it.each([false, true])('preserves provider retry metadata with accounting outage, failure recorder unavailable=%s', async unavailable => {
    const directory = await outbox();
    const recordFailure = vi.fn(async () => { if (unavailable) throw new Error('PRIVATE_FAILURE_STORAGE_ERROR'); });
    const write = vi.fn<(_: UsageCall) => Promise<void>>()
      .mockRejectedValueOnce(new Error('PRIVATE_DATABASE_ERROR')).mockResolvedValue(undefined);
    const execute = vi.fn(async (dispatch: Dispatch) => {
      dispatch.submitted(); throw new RequestFault('throttled', { status: 429, retryAt: Date.now() + 3600_000 });
    });
    await expect(infer('pi', 1000, context, recordFailure, execute, 5, {
      provider: 'openai-codex', model: 'm', recordUsage: write, usageOutboxDirectory: directory,
      reportUsageFailure: () => { throw new Error('Broken logger'); },
    })).rejects.toMatchObject({ metadata: { kind: 'throttled', retryable: true, status: 429,
      attempt: 2, nextRetryAt: expect.any(String) } });
    vi.setSystemTime(Date.now()+30_001);
    expect(await retryUsageWrites({ directory, record: write })).toBe(1);
    expect(write.mock.calls[1]?.[0]).toEqual(write.mock.calls[0]?.[0]);
    expect(execute).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledOnce();
  });
});
