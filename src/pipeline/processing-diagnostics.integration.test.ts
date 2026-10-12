import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
vi.mock('./collection.js', () => ({ collectBatch: vi.fn() }));
vi.mock('./extraction.js', () => ({ extractBatch: async () => { throw new Error('Missing representative'); } }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./vectors.js', () => ({ Vectors: class { async close() {} }, reembedPending: vi.fn() }));
const url = process.env.TEST_DATABASE_URL;
const schema = `diagnostics_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let batchId: string;
let storyId: string;
async function one(sql: string, args: unknown[] = []) {
  const id = (await database.db.query<{ id: string }>(sql, args)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture'); return id;
}
describe.skipIf(!url)('internal processing diagnostics with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE processing_batches,stories,operational_state CASCADE');
    batchId = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
    storyId = await one("INSERT INTO stories(chosen_excerpt) VALUES('Retained input') RETURNING id");
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('records the exact stage context, retains the original exception and does not change retry semantics', async () => {
    const { stage } = await import('./state.js');
    const error = new Error('Evidence changed during generation');
    error.stack = 'Error: PRIVATE_TOKEN\n    at privateFunction (/app/dist/pipeline/generation-store.js:154:7)';
    await expect(stage(batchId, { storyId }, 'research:fixture', settings, z.boolean(), async () => { throw error; })).rejects.toBe(error);
    const row = (await database.db.query<{ id: string; status: string; error_code: string; next_retry_at: Date | null }>(
      'SELECT id,status,error_code,next_retry_at FROM stage_state WHERE batch_id=$1', [batchId])).rows[0];
    if (!row) throw new Error('Missing receipt');
    expect(row).toMatchObject({ status: 'waiting', error_code: 'pipeline_failed', next_retry_at: expect.any(Date) });
    const saved = (await database.db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [`pipeline_error:stage:${row.id}`])).rows[0]?.value;
    expect(saved).toMatchObject({ code: 'evidence_changed_during_generation', context: { scope: 'stage', batchId, storyId, stageId: row.id, task: 'research' },
      frames: [{ file: 'dist/pipeline/generation-store.js', line: 154, column: 7 }] });
    expect(JSON.stringify(saved)).not.toContain('PRIVATE_TOKEN');
    const status = await (await (await import('./index.js')).createPipeline()).status();
    expect(JSON.stringify(status)).not.toContain('pipeline_error:');
    expect(JSON.stringify(status)).not.toContain('generation-store.js');
  });
  it('records real PostgreSQL SQLSTATE and static constraints without database error text', async () => {
    const { stage } = await import('./state.js');
    await expect(stage(batchId, { storyId }, 'research:duplicate', settings, z.boolean(), async () => {
      await database.db.query('INSERT INTO stories(id) VALUES($1)', [storyId]);
      return true;
    })).rejects.toMatchObject({ code: '23505', constraint: 'stories_pkey' });
    const value = (await database.db.query<{ value: unknown }>("SELECT value FROM operational_state WHERE key LIKE 'pipeline_error:stage:%'")).rows[0]?.value;
    expect(value).toMatchObject({ sqlState: '23505', constraint: 'stories_pkey' });
    expect(JSON.stringify(value)).not.toContain('duplicate key value');
    expect(JSON.stringify(value)).not.toContain('Key ((true))');
  });
  it('captures batch failures before a stage is dispatched', async () => {
    await expect((await import('./batches.js')).processBatch(true, true)).rejects.toThrow('Missing representative');
    expect((await database.db.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1', [`pipeline_error:batch:${batchId}`])).rows[0]?.value)
      .toMatchObject({ code: 'missing_representative', context: { scope: 'batch', batchId } });
  });
  it('captures digest failures internally while keeping public state sanitized and automatically retryable', async () => {
    const { operationalWork } = await import('./operational.js');
    const error = new TypeError('PRIVATE_TOKEN_AND_SOURCE_TEXT');
    await expect(operationalWork('pipeline_digest', settings, false, async () => { throw error; })).rejects.toBe(error);
    const rows = (await database.db.query<{ key: string; value: unknown }>('SELECT key,value FROM operational_state ORDER BY key')).rows;
    expect(rows.find(row => row.key === 'pipeline_error:operation:pipeline_digest')?.value)
      .toMatchObject({ errorName: 'TypeError', code: 'pipeline_failed', context: { operation: 'pipeline_digest' } });
    expect(rows.find(row => row.key === 'pipeline_digest')?.value).toMatchObject({ phase: 'waiting', code: 'pipeline_failed', next: expect.any(String) });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_TOKEN_AND_SOURCE_TEXT');
    expect(await operationalWork('pipeline_digest', settings, false, async () => { throw new Error('Unexpected auto resume'); })).toBe(false);
  });
});
