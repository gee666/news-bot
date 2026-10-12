import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db.js';
import { recordUsage, type UsageCall } from '../models/usage.js';
import { deliverUsage, startUsageRecovery } from '../models/usage-delivery.js';
import { usageOutboxStatus } from '../models/usage-outbox-status.js';
import { callsQuerySchema, usageQuerySchema } from './contracts.js';
import { usageCalls, usageStats } from './repository.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `usage_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let pool: pg.Pool;
const estimatedCost = { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 };
function call(overrides: Partial<UsageCall> = {}): UsageCall {
  return { id: randomUUID(), timestamp: '2026-01-01T12:00:00.000Z', provider: 'openai-codex', model: 'gpt-6-luna',
    operationId: 'research:00000000-0000-4000-8000-000000000001:queries', stage: 'research:queries', attempt: 1,
    outcome: 'completed', usageKnown: true, inputTokens: 10, outputTokens: 4, cacheReadTokens: 2,
    cacheWriteTokens: 1, totalTokens: 17, estimatedCost, actualBilledCost: null, durationMs: 120, ...overrides };
}

describe.skipIf(!databaseUrl)('persistent usage accounting', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('starts empty at migration and does not manufacture historical totals', async () => {
    const stats = await usageStats(usageQuerySchema.parse({}), pool);
    expect(stats.historicalUsageAvailable).toBe(false);
    expect(Date.parse(stats.accountingStartedAt)).toBeGreaterThan(0);
    expect(stats.totals).toMatchObject({ calls: 0, inputTokens: 0, estimatedCost: null, actualBilledCost: null });
    expect(stats.series).toEqual([]);
    await migrate(pool);
    expect((await usageStats(usageQuerySchema.parse({}), pool)).accountingStartedAt).toBe(stats.accountingStartedAt);
  });

  it('persists once per call ID, aggregates filters and costs with coverage, and pages details', async () => {
    const first = call();
    await recordUsage(first, pool);
    await recordUsage(first, pool);
    await recordUsage(call({ timestamp: '2026-01-02T12:00:00.000Z', stage: 'research:queries:repair' }), pool);
    await recordUsage(call({ timestamp: '2026-01-03T12:00:00.000Z', provider: 'jev', model: 'judge', stage: 'rank',
      estimatedCost: null, actualBilledCost: 0.5 }), pool);
    await recordUsage(call({ timestamp: '2026-01-04T12:00:00.000Z', outcome: 'failed', usageKnown: false,
      inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null,
      estimatedCost: null }), pool);
    const stats = await usageStats(usageQuerySchema.parse({}), pool);
    expect(stats.totals).toEqual({ calls: 4, completedCalls: 3, unknownUsageCalls: 1,
      inputTokens: 30, outputTokens: 12, cacheReadTokens: 6, cacheWriteTokens: 3, totalTokens: 51,
      estimatedCost: { input: 0.2, output: 0.4, cacheRead: 0.02, cacheWrite: 0.04, total: 0.66 },
      estimatedCostCalls: 2, actualBilledCost: 0.5, actualBilledCostCalls: 1 });
    expect(stats.series.map(point => point.timestamp)).toEqual([
      '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z',
    ]);
    expect(stats.groups).toHaveLength(3);
    expect(stats.options.providers).toEqual(['jev', 'openai-codex']);
    const filter = { from: '2026-01-02T12:00:00Z', to: '2026-01-03T12:00:00Z',
      provider: 'openai-codex', model: 'gpt-6-luna', stage: 'research:queries:repair', bucket: 'hour' };
    const filtered = await usageStats(usageQuerySchema.parse(filter), pool);
    expect(filtered.totals.calls).toBe(1);
    expect(filtered.series[0]?.timestamp).toBe('2026-01-02T12:00:00.000Z');
    expect(filtered.options).toEqual(stats.options);
    expect((await usageStats(usageQuerySchema.parse({ model: "x' OR true --" }), pool)).totals.calls).toBe(0);
    const page = await usageCalls(callsQuerySchema.parse({ limit: 2, offset: 1 }), pool);
    expect(page.total).toBe(4);
    expect(page.calls.map(row => row.provider)).toEqual(['jev', 'openai-codex']);
    expect(page.calls[1]?.stage).toBe('research:queries:repair');
    expect((await usageCalls(callsQuerySchema.parse({ offset: 20 }), pool)).calls).toEqual([]);
  });

  it('recovers an ambiguous committed write without duplicating usage or dispatching inference', async () => {
    const directory = await mkdtemp(resolve('tmp/usage-db-outbox-'));
    vi.stubEnv('MODEL_USAGE_OUTBOX_DIR', directory);
    let stop: (() => Promise<void>) | undefined;
    try {
      const entry = call({ provider: 'outbox', inputTokens: 50, outputTokens: 5,
        cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens: 105 });
      await deliverUsage(entry, { directory, report: () => {}, record: async value => {
        await recordUsage(value, pool);
        throw new Error('Connection dropped after commit');
      } });
      expect(await usageOutboxStatus()).toMatchObject({ state: 'ready', pendingRecords: 1 });
      stop = startUsageRecovery(1000, { directory, record: value => recordUsage(value, pool) });
      await stop(); stop = undefined;
      expect(await usageOutboxStatus()).toMatchObject({ state: 'ready', pendingRecords: 0, replaying: false,
        lastReplayRecordedRecords: 1, lastReplayFailed: false });
      const stats = await usageStats(usageQuerySchema.parse({ provider: 'outbox' }), pool);
      expect(stats.totals).toMatchObject({ calls: 1, inputTokens: 50, outputTokens: 5,
        cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens: 105 });
    } finally {
      await stop?.(); vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses deterministic ties for pagination and caps series without truncating totals', async () => {
    const first = call({ id: '00000000-0000-4000-8000-000000000001', provider: 'tie' });
    const second = call({ id: '00000000-0000-4000-8000-000000000002', provider: 'tie' });
    await recordUsage(first, pool);
    await recordUsage(second, pool);
    const page = await usageCalls(callsQuerySchema.parse({ provider: 'tie', limit: 1, offset: 1 }), pool);
    expect(page.total).toBe(2);
    expect(page.calls[0]?.id).toBe(first.id);
    await pool.query(`INSERT INTO model_usage_calls
      (id,timestamp,provider,model,stage,attempt,outcome,usage_known,duration_ms)
      SELECT gen_random_uuid(),'2026-01-01T00:00:00Z'::timestamptz + n * interval '1 hour',
        'series','test','test',1,'failed',false,0 FROM generate_series(0,1000) n`);
    const stats = await usageStats(usageQuerySchema.parse({ provider: 'series', bucket: 'hour' }), pool);
    expect(stats.totals.calls).toBe(1001);
    expect(stats.series).toHaveLength(1000);
    expect(stats.seriesTruncated).toBe(true);
    expect(stats.series[0]?.timestamp).toBe('2026-01-01T01:00:00.000Z');
  });

  it('resolves database stage names and preserves their repair suffix without retention foreign keys', async () => {
    const batch = await pool.query<{ id: string }>(`INSERT INTO processing_batches
      (cutoff_at,settings_snapshot,profile_version,model_version) VALUES(now(),'{}',1,1) RETURNING id`);
    const story = await pool.query<{ id: string }>('INSERT INTO stories DEFAULT VALUES RETURNING id');
    const stage = await pool.query<{ id: string }>(`INSERT INTO stage_state(batch_id,story_id,stage)
      VALUES($1,$2,'extract:v2') RETURNING id`, [batch.rows[0]?.id, story.rows[0]?.id]);
    const id = stage.rows[0]?.id;
    if (!id) throw new Error('Missing stage');
    const entry = call({ operationId: id + ':repair', stage: 'repair' });
    await recordUsage(entry, pool);
    await pool.query('DELETE FROM stage_state WHERE id=$1', [id]);
    const page = await usageCalls(callsQuerySchema.parse({ stage: 'extract:v2:repair' }), pool);
    expect(page.calls[0]?.id).toBe(entry.id);
    expect(page.calls[0]?.stage).toBe('extract:v2:repair');
  });
});
