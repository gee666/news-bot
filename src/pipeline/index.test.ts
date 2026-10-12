import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ held: [] as boolean[], query: vi.fn(), publish: vi.fn(), refresh: vi.fn(), release: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query, connect: async () => ({
  query: async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ held: mocks.held.shift() ?? false }] : [] }),
  release: mocks.release,
}) }, transaction: vi.fn() }));
vi.mock('../settings.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../settings.js')>();
  return { ...actual, getSettings: async () => actual.defaultSettings };
});
vi.mock('../publishing/index.js', () => ({ publishDigest: mocks.publish }));
vi.mock('./stories.js', () => ({ refreshDigest: mocks.refresh }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./batches.js', () => ({ processBatch: vi.fn() }));
vi.mock('./consolidation.js', () => ({ consolidateStories: vi.fn() }));
vi.mock('./source-links.js', () => ({ associateSourceLinks: vi.fn(), SOURCE_MESSAGES_PER_PASS: 50 }));
vi.mock('./vectors.js', () => ({ reembedPending: vi.fn() }));
import { createPipeline } from './index.js';
import { processBatch } from './batches.js';
import { consolidateStories } from './consolidation.js';
import { associateSourceLinks } from './source-links.js';
import { checkProcessingSlice } from './processing-slice.js';

beforeEach(() => {
  mocks.held.length = 0;
  vi.mocked(consolidateStories).mockReset().mockResolvedValue({ examined: 0, merged: 0, deferred: 0 });
  vi.mocked(associateSourceLinks).mockReset().mockResolvedValue({ messages: 0, excluded: 0, compared: 0, associated: 0, deferred: 0 });
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.publish.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue({ completedStories: 1, failedStories: 0, skippedStories: 0 });
  mocks.release.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
function savedStates(): unknown[] {
  return mocks.query.mock.calls.filter(call => String(call[0]).includes('INSERT INTO operational_state'))
    .map(call => JSON.parse(String(call[1]?.[1])) as unknown);
}
it('records uncaught background errors internally without exposing their messages', async () => {
  mocks.held.push(true);
  vi.mocked(processBatch).mockRejectedValueOnce(new Error('PRIVATE_LAUNCH_SECRET'));
  const pipeline = await createPipeline();
  try { await pipeline.start(); } finally { await pipeline.stop(); }
  expect(savedStates()).toContainEqual(expect.objectContaining({ code: 'pipeline_failed',
    context: expect.objectContaining({ operation: 'pipeline_launch' }) }));
  expect(JSON.stringify(savedStates())).not.toContain('PRIVATE_LAUNCH_SECRET');
  expect(savedStates().at(-1)).toMatchObject({ code: 'pipeline_failed' });
});
it('automatic recovery prioritizes story refresh and publication over historical enrichment while intake is pending', async () => {
  mocks.query.mockImplementation(async (sql: string) => ({ rows:
    sql.includes('FROM batch_items b JOIN processing_batches') || sql.includes("key='pipeline_digest' AND") ? [{pending:true}] : [] }));
  mocks.held.push(true,true,true);
  const pipeline=await createPipeline();
  try {
    await pipeline.start();
    await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledOnce());
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(consolidateStories).not.toHaveBeenCalled(); expect(associateSourceLinks).not.toHaveBeenCalled();
  } finally { await pipeline.stop(); }
});

it('manual digest still includes enrichment when automatic intake has a backlog', async () => {
  mocks.query.mockImplementation(async (sql: string) => ({ rows:
    sql.includes('FROM batch_items b JOIN processing_batches') ? [{pending:true}] : [] }));
  mocks.held.push(true,true,true,true);
  await (await createPipeline()).runDigest();
  expect(consolidateStories).toHaveBeenCalledOnce(); expect(associateSourceLinks).toHaveBeenCalledOnce();
  expect(mocks.publish).toHaveBeenCalledOnce();
});

describe('digest phase slices', () => {
  it('publishes current ready stories while processor contention defers refresh', async () => {
    mocks.held.push(true, false, false, false);
    await (await createPipeline()).runDigest();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(consolidateStories).not.toHaveBeenCalled();
    expect(associateSourceLinks).not.toHaveBeenCalled();
    expect(savedStates().at(-1)).toMatchObject({ phase: 'waiting', code: 'lease_busy', attempt: 0, next: expect.any(String) });
    expect(savedStates()).not.toContainEqual(expect.objectContaining({ phase: 'completed' }));
  });

  it.each(['consolidation', 'source_links', 'story_refresh'] as const)('continues after %s yields, with fresh phase slices and publication before deferral', async phase => {
    vi.stubEnv('PROCESSING_SLICE_MS', '1000');
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const step = (name: string) => { if (name === phase) clock += 1001; checkProcessingSlice(); };
    vi.mocked(consolidateStories).mockImplementation(async () => {
      step('consolidation'); return { examined: 0, merged: 0, deferred: 0 };
    });
    vi.mocked(associateSourceLinks).mockImplementation(async () => {
      step('source_links'); return { messages: 0, excluded: 0, compared: 0, associated: 0, deferred: 0 };
    });
    mocks.refresh.mockImplementation(async () => {
      step('story_refresh'); return { completedStories: 1, failedStories: 0, skippedStories: 0 };
    });
    mocks.publish.mockImplementation(async () => {
      expect(mocks.release).toHaveBeenCalledTimes(3);
      expect(savedStates().at(-1)).toMatchObject({ phase: 'running' });
    });
    mocks.held.push(true, true, true, true);
    await (await createPipeline()).runDigest();
    expect(consolidateStories).toHaveBeenCalledOnce();
    expect(associateSourceLinks).toHaveBeenCalledOnce();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledTimes(4);
    expect(savedStates()).toHaveLength(2);
    expect(savedStates().at(-1)).toMatchObject({ phase: 'waiting', attempt: 0, next: expect.any(String) });
  });

  it('honors the saved partial-sweep deadline and retries without spending failure attempts', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let state: unknown;
    mocks.query.mockImplementation(async (sql: string, args: unknown[] = []) => {
      if (sql.includes('SELECT value FROM operational_state')) return { rows: state ? [{ value: state }] : [] };
      if (sql.includes('INSERT INTO operational_state')) state = JSON.parse(String(args[1]));
      return { rows: [] };
    });
    const { ProcessingYield } = await import('./processing-slice.js');
    vi.mocked(associateSourceLinks).mockRejectedValueOnce(new ProcessingYield());
    const pipeline = await createPipeline();
    mocks.held.push(true, true, true, true);
    await pipeline.runDigest();
    expect(state).toMatchObject({ phase: 'waiting', attempt: 0 });
    mocks.held.push(true);
    await pipeline.runDigest();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(associateSourceLinks).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 15_001);
    mocks.held.push(true, true, true, true);
    await pipeline.runDigest();
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ phase: 'completed', attempt: 0 });
  });

  it.each(['consolidation', 'source links', 'refresh'] as const)('does not disguise an infrastructure outage in %s as successful publication', async phase => {
    const failure = Object.assign(new Error('fixture database outage'), { code: '08006' });
    const work = phase === 'consolidation' ? vi.mocked(consolidateStories)
      : phase === 'source links' ? vi.mocked(associateSourceLinks) : mocks.refresh;
    work.mockRejectedValueOnce(failure);
    const pipeline = await createPipeline();
    mocks.held.push(true, true, true, true);
    await expect(pipeline.runDigest()).rejects.toThrow('fixture database outage');
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(savedStates().at(-1)).toMatchObject({ phase: 'waiting', attempt: 1 });
    mocks.held.length = 0; mocks.held.push(true, true, true, true);
    await pipeline.runDigest();
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('retries a full source-message page after publication even when its healthy work finishes within the slice', async () => {
    vi.mocked(associateSourceLinks).mockResolvedValueOnce({ messages: 50, excluded: 50, compared: 0, associated: 0, deferred: 0 });
    mocks.held.push(true, true, true, true);
    await (await createPipeline()).runDigest();
    expect(mocks.refresh).toHaveBeenCalledOnce(); expect(mocks.publish).toHaveBeenCalledOnce();
    expect(savedStates().at(-1)).toMatchObject({ phase: 'waiting', attempt: 0, next: expect.any(String) });
  });

  it('publishes healthy siblings when selections or stories have isolated failures', async () => {
    vi.mocked(consolidateStories).mockResolvedValueOnce({ examined: 0, merged: 0, deferred: 1 });
    mocks.refresh.mockResolvedValueOnce({ completedStories: 1, failedStories: 1, skippedStories: 0 });
    mocks.held.push(true, true, true, true);
    await (await createPipeline()).runDigest();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(savedStates().at(-1)).toMatchObject({ phase: 'completed', failedStories: 1, deferredSelections: 1 });
  });

  it('completes after separate processor leases without a history-wide generation guard', async () => {
    mocks.held.push(true, true, true, true);
    await (await createPipeline()).runDigest();
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(savedStates().at(-1)).toMatchObject({ phase: 'completed' });
    expect(mocks.release).toHaveBeenCalledTimes(4);
  });
});
