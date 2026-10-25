import { randomUUID } from 'node:crypto';
import pg from 'pg';
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
    await database.db.query('TRUNCATE processing_batches,sources,stories,operational_state CASCADE');
    batchId = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
    storyId = await one("INSERT INTO stories(chosen_excerpt) VALUES('Retained input') RETURNING id");
    const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed','diagnostic','Fixture','public') RETURNING id");
    const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'1') RETURNING id", [source]);
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,1,'fixture','Retained input','Retained input') RETURNING id`, [item]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
    await database.db.query("INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,'Retained input',0)", [revision, storyId]);
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('records a story failure once with one retry budget and no stage receipt', async () => {
    const { storyWork } = await import('./story-failures.js');
    const error = new Error('Evidence changed during generation');
    error.stack = 'Error: PRIVATE_TOKEN\n    at privateFunction (/app/dist/pipeline/generation-store.js:154:7)';
    const run = vi.fn(async () => { throw error; });
    expect(await storyWork(storyId, settings, batchId, run)).toBe('failed');
    expect(await storyWork(storyId, settings, batchId, run)).toBe('skipped');
    expect(run).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT id FROM stage_state WHERE batch_id=$1', [batchId])).rows).toEqual([]);
    const rows = (await database.db.query<{ key: string; value: unknown }>('SELECT key,value FROM operational_state')).rows;
    expect(rows.filter(row => row.key.startsWith('pipeline_error:'))).toHaveLength(1);
    expect(rows.find(row => row.key.startsWith('pipeline_error:'))?.value).toMatchObject({
      code: 'evidence_changed_during_generation', context: { scope: 'story', batchId, storyId },
      frames: [{ file: 'dist/pipeline/generation-store.js', line: 154, column: 7 }],
    });
    expect(rows.find(row => row.key === `pipeline_failed_story:${storyId}`)?.value).toMatchObject({
      attempts: 1, next: expect.any(String), errorCode: 'pipeline_failed',
    });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE_TOKEN');
    const status = await (await (await import('./index.js')).createPipeline()).status();
    expect(JSON.stringify(status)).not.toContain('pipeline_error:');
    expect(JSON.stringify(status)).not.toContain('generation-store.js');
  });
  it('records real PostgreSQL SQLSTATE and static constraints without database error text', async () => {
    const { storyWork } = await import('./story-failures.js');
    expect(await storyWork(storyId, settings, batchId, async () => {
      await database.db.query('INSERT INTO stories(id) VALUES($1)', [storyId]);
      return true;
    })).toBe('failed');
    const value = (await database.db.query<{ value: unknown }>("SELECT value FROM operational_state WHERE key LIKE 'pipeline_error:story:%'")).rows[0]?.value;
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
