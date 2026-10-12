import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { ModelRequestError, RequestFault, failureMetadata } from '../models/errors.js';
const mocks = vi.hoisted(() => ({ clock: 0, firstCalls: 0, secondCalls: 0, overrun: true, providerFailure: false, competitorRan: false }));
vi.mock('./collection.js', () => ({ collectBatch: vi.fn() }));
vi.mock('./extraction.js', () => ({ extractBatch: async (batchId: string, settings: AppSettings) => {
  const { db } = await import('../db.js'); const { stage, recordFailure } = await import('./state.js');
  const { withLease } = await import('./lease.js');
  const revision = (await db.query<{ revision_id: string }>('SELECT revision_id FROM batch_items WHERE batch_id=$1', [batchId])).rows[0];
  if (!revision) throw new Error('Missing revision');
  const first = await stage(batchId, { revisionId: revision.revision_id }, 'slice_first', settings, z.boolean(), async context => {
    mocks.firstCalls++;
    if (mocks.overrun) mocks.clock += 1_001;
    const acquired = await withLease('news-bot-pipeline', async () => { mocks.competitorRan = true; });
    expect(acquired).toBe(false); // The current stage owns the lease until it finishes, even after its slice expires.
    if (mocks.providerFailure) {
      const failure = failureMetadata(new RequestFault('throttled', { retryAt: Date.now() + 3_600_000 }), context.id, 'jev', context.attempt, 0);
      await recordFailure(failure); throw new ModelRequestError(failure);
    }
    return true;
  });
  expect(first).toBe(true);
  await stage(batchId, { revisionId: revision.revision_id }, 'slice_second', settings, z.boolean(), async () => { mocks.secondCalls++; return true; });
  // The fake extractor must supply positive completion proof, not rely on an untouched pending row.
  await db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,output)
    VALUES($1,$2,'links:events-v5','completed','true') ON CONFLICT DO NOTHING`, [batchId,revision.revision_id]);
} }));
vi.mock('./matching.js', () => ({ matchBatch: vi.fn() }));
vi.mock('./revisions.js', () => ({ reconcileEdits: vi.fn() }));
vi.mock('./consolidation.js', () => ({ consolidateStories: vi.fn() }));
vi.mock('./source-links.js', () => ({ associateSourceLinks: vi.fn(), SOURCE_MESSAGES_PER_PASS: 50 }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./vectors.js', () => ({ Vectors: class { async close() {} } }));
const url = process.env.TEST_DATABASE_URL;
const schema = `processing_slice_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let batchId: string;
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function runBatch() {
  const { processBatch } = await import('./batches.js'); const { withLease } = await import('./lease.js');
  return withLease('news-bot-pipeline', () => processBatch(false, true));
}
describe.skipIf(!url)('cooperative batch checkpoints with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3'); vi.stubEnv('PROCESSING_SLICE_MS', '1000');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE processing_batches,sources,source_items CASCADE');
    mocks.clock = 0; mocks.firstCalls = 0; mocks.secondCalls = 0; mocks.overrun = true; mocks.providerFailure = false; mocks.competitorRan = false;
    vi.spyOn(performance, 'now').mockImplementation(() => mocks.clock);
    const source = await one("INSERT INTO sources(connector_type,external_id,name) VALUES('feed','fixture','Fixture') RETURNING id");
    const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'item') RETURNING id", [source]);
    const revision = await one("INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text) VALUES($1,1,'fixture','News','News') RETURNING id", [item]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
    batchId = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
    await database.db.query(`INSERT INTO batch_sources(batch_id,source_id,status,cursor_before,cursor_after)
      VALUES($1,$2,'completed','{"offset":10}','{"offset":20}')`, [batchId, source]);
  });
  afterAll(async () => {
    vi.restoreAllMocks(); if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('finishes overrun work, checkpoints before another stage, releases the lease and reuses completed receipts', async () => {
    const original = (await database.db.query('SELECT cutoff_at,settings_snapshot FROM processing_batches WHERE id=$1', [batchId])).rows[0];
    const members = (await database.db.query('SELECT revision_id FROM batch_items WHERE batch_id=$1', [batchId])).rows;
    const cursors = (await database.db.query('SELECT * FROM batch_sources WHERE batch_id=$1', [batchId])).rows;
    expect(await runBatch()).toBe(true);
    expect(mocks.firstCalls).toBe(1); expect(mocks.secondCalls).toBe(0); expect(mocks.competitorRan).toBe(false);
    expect((await database.db.query('SELECT status,attempts,error_code,outcome_unknown FROM stage_state WHERE batch_id=$1 ORDER BY stage', [batchId])).rows)
      .toEqual([{ status: 'completed', attempts: 0, error_code: null, outcome_unknown: false },
        { status: 'pending', attempts: 0, error_code: null, outcome_unknown: false }]);
    const parked = (await database.db.query('SELECT status,next_retry_at,error_code,waiting_reason FROM processing_batches WHERE id=$1', [batchId])).rows[0];
    expect(parked).toMatchObject({ status: 'waiting', error_code: null, waiting_reason: expect.stringContaining('checkpoint'), next_retry_at: expect.any(Date) });
    expect(parked.next_retry_at.getTime()).toBeGreaterThan(Date.now());
    expect(parked.next_retry_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_100);
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toHaveLength(0);
    const { withLease } = await import('./lease.js');
    expect(await withLease('news-bot-pipeline', async () => { mocks.competitorRan = true; })).toBe(true);
    expect(mocks.competitorRan).toBe(true);
    await runBatch(); expect(mocks.secondCalls).toBe(0); // Even a checkpoint's future deadline remains enforced.
    await database.db.query("UPDATE processing_batches SET next_retry_at=now()-interval '1 second' WHERE id=$1", [batchId]);
    expect(await runBatch()).toBe(true);
    expect(mocks.firstCalls).toBe(1); expect(mocks.secondCalls).toBe(1);
    expect((await database.db.query("SELECT status,attempts,retry_epoch FROM stage_state WHERE batch_id=$1 AND stage LIKE 'slice_%' ORDER BY stage", [batchId])).rows)
      .toEqual([{ status: 'completed', attempts: 0, retry_epoch: 0 }, { status: 'completed', attempts: 0, retry_epoch: 0 }]);
    expect((await database.db.query('SELECT status,cutoff_at,settings_snapshot FROM processing_batches WHERE id=$1', [batchId])).rows[0])
      .toEqual({ ...original, status: 'completed' });
    expect((await database.db.query('SELECT revision_id FROM batch_items WHERE batch_id=$1', [batchId])).rows).toEqual(members);
    expect((await database.db.query('SELECT * FROM batch_sources WHERE batch_id=$1', [batchId])).rows).toEqual(cursors);
  });
  it('keeps provider cooldown/error history when an overrun stage fails instead of checkpointing it', async () => {
    mocks.providerFailure = true;
    await expect(runBatch()).rejects.toMatchObject({ metadata: { kind: 'throttled' } });
    expect(mocks.firstCalls).toBe(1); expect(mocks.secondCalls).toBe(0);
    const parked = (await database.db.query('SELECT status,next_retry_at,error_code FROM processing_batches WHERE id=$1', [batchId])).rows[0];
    expect(parked).toMatchObject({ status: 'waiting', error_code: 'throttled' });
    expect(parked.next_retry_at.getTime()).toBeGreaterThan(Date.now() + 3_590_000);
    await runBatch(); expect(mocks.firstCalls).toBe(1);
    expect((await database.db.query('SELECT status,attempts,error_code FROM stage_state WHERE batch_id=$1', [batchId])).rows)
      .toEqual([{ status: 'waiting', attempts: 1, error_code: 'throttled' }]);
    expect((await database.db.query('SELECT error_code FROM request_attempts')).rows).toEqual([{ error_code: 'throttled' }]);
  });
});
