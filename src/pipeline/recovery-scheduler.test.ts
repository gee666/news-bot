import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), process: vi.fn(), refresh: vi.fn(), publish: vi.fn(), diagnostic: vi.fn(),
  drain: vi.fn(), request: vi.fn(), destroy: vi.fn(),
  leases: new Set<string>(), leaseAttempts: [] as string[], turns: [] as string[],
  operations: new Map<string, Record<string, unknown>>(),
  scheduled: new Map<string, (context: { date: Date }) => Promise<void>>(),
  pendingSlots: [] as Date[], collectedSlots: [] as Date[], alwaysDue: false,
}));
vi.mock('../db.js', () => ({ db: {
  query: mocks.query,
  connect: async () => ({
    query: async (sql: string, args: string[]) => {
      const name = args[0];
      if (!name) throw new Error('Missing lease name');
      if (sql.includes('pg_try_advisory_lock')) {
        mocks.leaseAttempts.push(name);
        const held = !mocks.leases.has(name);
        if (held) mocks.leases.add(name);
        return { rows: [{ held }] };
      }
      if (!sql.includes('pg_advisory_unlock')) throw new Error('Unexpected lease query');
      mocks.leases.delete(name);
      return { rows: [] };
    },
    release: vi.fn(),
  }),
}, transaction: vi.fn() }));
vi.mock('node-cron', async importOriginal => {
  const actual = await importOriginal<typeof import('node-cron')>();
  return { default: { ...actual.default,
    schedule: (expression: string, callback: (context: { date: Date }) => Promise<void>) => {
      mocks.scheduled.set(expression, callback);
      return { destroy: mocks.destroy };
    },
  } };
});
vi.mock('../settings.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../settings.js')>();
  return { ...actual, getSettings: async () => actual.defaultSettings };
});
vi.mock('../publishing/index.js', () => ({ publishDigest: mocks.publish }));
vi.mock('./batches.js', () => ({ processBatch: mocks.process }));
vi.mock('./stories.js', () => ({ refreshDigest: mocks.refresh }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./consolidation.js', () => ({ consolidateStories: vi.fn() }));
vi.mock('./source-links.js', () => ({ associateSourceLinks: vi.fn(), SOURCE_MESSAGES_PER_PASS: 50 }));
vi.mock('./vectors.js', () => ({ reembedPending: vi.fn() }));
vi.mock('./processing-diagnostics.js', () => ({ recordProcessingDiagnostic: mocks.diagnostic }));
vi.mock('./scheduled-intake.js', () => ({ requestScheduledIntake: mocks.request, requestLatestScheduledIntake:vi.fn(async()=>{}), drainScheduledIntake: mocks.drain }));

import { createPipeline, type Pipeline } from './index.js';
import { defaultSettings } from '../settings.js';
import { associateSourceLinks } from './source-links.js';
import { checkProcessingSlice } from './processing-slice.js';

let pipeline: Pipeline | undefined;
const delay = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });
function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function waiting(next = new Date().toISOString()) {
  mocks.operations.set('pipeline_digest', { phase: 'waiting', code: 'lease_busy', next, attempt: 0, totalAttempts: 0 });
}
async function start() {
  pipeline = await createPipeline();
  await pipeline.start();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-10-08T23:59:00Z');
  mocks.leases.clear(); mocks.leaseAttempts.length = 0; mocks.turns.length = 0;
  mocks.operations.clear(); mocks.scheduled.clear(); mocks.pendingSlots.length = 0; mocks.collectedSlots.length = 0;
  mocks.alwaysDue = false;
  vi.mocked(associateSourceLinks).mockReset();
  mocks.diagnostic.mockReset().mockResolvedValue(undefined);
  mocks.destroy.mockReset().mockResolvedValue(undefined);
  mocks.publish.mockReset().mockResolvedValue(undefined);
  mocks.request.mockReset().mockImplementation(async (slot: Date) => { mocks.pendingSlots.push(slot); });
  mocks.drain.mockReset().mockImplementation(async () => {
    const slot = mocks.pendingSlots.shift();
    if (slot) mocks.collectedSlots.push(slot);
  });
  mocks.process.mockReset().mockImplementation(async () => { mocks.turns.push('collection'); });
  mocks.refresh.mockReset().mockImplementation(async () => {
    mocks.turns.push('digest');
    return { completedStories: 1, failedStories: 0, skippedStories: 0 };
  });
  mocks.query.mockReset().mockImplementation(async (sql: string, args?: unknown[]) => {
    if (sql.includes("key='pipeline_digest'")) {
      const state = mocks.operations.get('pipeline_digest');
      const due = state && (state.phase === 'running' || (['waiting', 'failed'].includes(String(state.phase))
        && typeof state.next === 'string' && Date.parse(state.next) <= Date.now()));
      return { rows: due || mocks.alwaysDue ? [{}] : [] };
    }
    if (sql.includes('SELECT value FROM operational_state WHERE key=$1')) {
      const key = z.string().parse(args?.[0]);
      const value = mocks.operations.get(key);
      return { rows: value ? [{ value }] : [] };
    }
    if (sql.includes('INSERT INTO operational_state')) {
      const key = z.string().parse(args?.[0]);
      const encoded = z.string().parse(args?.[1]);
      mocks.operations.set(key, z.record(z.string(), z.unknown()).parse(JSON.parse(encoded)));
      return { rows: [] };
    }
    // Parked batches remain present, but this collection turn does no model work.
    if (sql.includes('FROM processing_batches')) return { rows: [{}] };
    return { rows: [] };
  });
});
afterEach(async () => {
  const stopping = pipeline?.stop();
  await vi.advanceTimersByTimeAsync(45_000);
  await stopping; pipeline = undefined;
  vi.useRealTimers(); vi.unstubAllEnvs();
});

describe('automatic recovery fairness', () => {
  it('returns the tracked work promise to cron so noOverlap covers the full dispatch', async () => {
    await start();
    const work = deferred();
    mocks.process.mockImplementationOnce(async () => { await work.promise; });
    const callback = mocks.scheduled.get(defaultSettings.collectionCron);
    if (!callback) throw new Error('Missing collection callback');
    let settled = false;
    const dispatch = callback({ date: new Date() }).then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      work.release(); await dispatch;
      expect(settled).toBe(true);
    } finally { work.release(); }
  });

  it('breaks the same-cadence lease collision with parked collection work', async () => {
    waiting();
    mocks.process.mockImplementation(async () => { mocks.turns.push('collection'); await delay(25); });
    await start();
    await vi.advanceTimersByTimeAsync(60_050);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.process.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(mocks.operations.get('pipeline_digest')).toMatchObject({ phase: 'completed', attempt: 0 });
    expect(mocks.turns.slice(0, 2)).toEqual(['collection', 'digest']);
  });

  it('gives collection a turn between continuously due, slow digests', async () => {
    mocks.alwaysDue = true;
    mocks.refresh.mockImplementation(async () => {
      mocks.turns.push('digest'); await delay(45_000);
      return { completedStories: 1, failedStories: 0, skippedStories: 0 };
    });
    await start();
    await vi.advanceTimersByTimeAsync(165_000);
    expect(mocks.turns).toEqual(['collection', 'digest', 'collection', 'digest', 'collection', 'digest']);
    expect(mocks.publish).toHaveBeenCalledTimes(3);
    expect(mocks.leases.size).toBe(0);
  });

  it('bounds a healthy source-link backlog while refresh, publication and collection keep taking turns', async () => {
    vi.stubEnv('PROCESSING_SLICE_MS', '1000'); mocks.alwaysDue = true;
    vi.mocked(associateSourceLinks).mockImplementation(async () => {
      for (let index = 0; index < 50; index++) { checkProcessingSlice(); await delay(500); }
      return;
    });
    await start();
    await vi.advanceTimersByTimeAsync(31_001);
    expect(mocks.process.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.operations.get('pipeline_digest')).toMatchObject({ phase: 'waiting', attempt: 0, next: expect.any(String) });
    expect(mocks.diagnostic).not.toHaveBeenCalled();
    expect(mocks.leases.size).toBe(0);
  });

  it('coalesces ticks during slow collection, then runs the waiting digest', async () => {
    const work = deferred();
    waiting();
    mocks.process.mockImplementationOnce(async () => { mocks.turns.push('collection'); await work.promise; });
    try {
      await start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.leaseAttempts).toEqual(['news-bot-pipeline']);
      expect(mocks.refresh).not.toHaveBeenCalled();
      work.release(); await vi.advanceTimersByTimeAsync(0);
      expect(mocks.turns).toEqual(['collection', 'digest']);
      expect(mocks.publish).toHaveBeenCalledOnce();
    } finally { work.release(); }
  });

  it('persists a cron collection slot while digest owns the processor and drains it on the next turn', async () => {
    const work = deferred();
    waiting();
    mocks.refresh.mockImplementationOnce(async () => { mocks.turns.push('digest'); await work.promise; });
    try {
      await start();
      const slot = new Date();
      const collect = mocks.scheduled.get(defaultSettings.collectionCron);
      if (!collect) throw new Error('Missing collection schedule');
      collect({ date: slot }); await vi.advanceTimersByTimeAsync(0);
      expect(mocks.request).toHaveBeenCalledWith(slot);
      expect(mocks.collectedSlots).toEqual([]);
      work.release(); await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(mocks.collectedSlots).toEqual([slot]);
      expect(mocks.process).toHaveBeenCalledTimes(2);
    } finally { work.release(); }
  });

  it('still attempts a due digest after collection recovery fails', async () => {
    waiting();
    mocks.process.mockRejectedValueOnce(new Error('collection failed'));
    await start();
    expect(mocks.diagnostic).toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.process).toHaveBeenCalledTimes(2);
  });

  it('continues collection while a failed digest backs off and retries automatically', async () => {
    waiting();
    mocks.refresh.mockRejectedValueOnce(new Error('digest failed'));
    await start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.process).toHaveBeenCalledTimes(3);
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.operations.get('pipeline_digest')).toMatchObject({ phase: 'completed' });
  });

  it('keeps the persisted digest deadline binding while collection continues', async () => {
    waiting(new Date(Date.now() + 45_000).toISOString());
    await start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.process).toHaveBeenCalledTimes(3);
    expect(mocks.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('releases the sweep guard after a failed due-state lookup', async () => {
    waiting();
    const query = mocks.query.getMockImplementation();
    if (!query) throw new Error('Missing query fixture');
    let failed = false;
    mocks.query.mockImplementation(async (sql: string, args?: unknown[]) => {
      if (!failed && sql.includes("key='pipeline_digest'")) {
        failed = true; throw new Error('lookup failed');
      }
      return query(sql, args);
    });
    await start();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.diagnostic).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });

  it('retains lease deferral for an external owner and recovers after it releases', async () => {
    waiting();
    mocks.leases.add('news-bot-pipeline');
    await start();
    expect(mocks.operations.get('pipeline_digest')).toMatchObject({ phase: 'waiting', code: 'lease_busy', attempt: 0 });
    expect(mocks.publish).toHaveBeenCalledOnce();
    mocks.leases.delete('news-bot-pipeline');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.turns).toEqual(['collection', 'digest']);
    expect(mocks.publish).toHaveBeenCalledTimes(2);
  });

  it('waits for active collection at shutdown without starting the next recovery leg', async () => {
    const work = deferred();
    waiting();
    mocks.process.mockImplementationOnce(async () => { await work.promise; });
    try {
      await start();
      if (!pipeline) throw new Error('Missing pipeline');
      const stopping = pipeline.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      work.release(); await stopping;
      expect(mocks.refresh).not.toHaveBeenCalled();
      expect(mocks.destroy).toHaveBeenCalledTimes(3);
      expect(mocks.leases.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await pipeline.start(); await vi.advanceTimersByTimeAsync(0);
      expect(mocks.publish).toHaveBeenCalledOnce();
    } finally { work.release(); }
  });
});
