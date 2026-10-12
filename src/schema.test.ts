import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './db.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `test_${randomUUID().replaceAll('-', '')}`;
let pool: pg.Pool;
let admin: pg.Pool;

// Use a disposable test database. Tests isolate their tables in a random schema.
describe.skipIf(!databaseUrl)('PostgreSQL schema integration', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
    await migrate(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('shortens only default automatic Pi deadlines, preserving custom and historical budgets', async () => {
    await pool.query(`INSERT INTO app_settings(id,value) VALUES(1,'{"piTimeoutMs":1200000}')
      ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value`);
    const fixtures=[
      {timeout:1_200_000,manual:null,completed:false,expected:300_000},
      {timeout:900_000,manual:null,completed:false,expected:900_000},
      {timeout:1_200_000,manual:randomUUID(),completed:false,expected:1_200_000},
      {timeout:1_200_000,manual:null,completed:true,expected:1_200_000},
    ];
    const ids:string[]=[];
    for(const fixture of fixtures) {
      const row=(await pool.query<{id:string}>(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,
        profile_version,model_version,manual_operation_id,completed_at,status)
        VALUES(now(),$1,1,1,$2,CASE WHEN $3 THEN now() END,CASE WHEN $3 THEN 'completed' ELSE 'queued' END) RETURNING id`,
      [JSON.stringify({piTimeoutMs:fixture.timeout}),fixture.manual,fixture.completed])).rows[0];
      if(!row) throw new Error('Missing deadline fixture');
      ids.push(row.id);
    }
    const sql=await readFile(new URL('../migrations/194_pi_request_deadline.sql',import.meta.url),'utf8');
    await pool.query(sql);
    expect((await pool.query<{deadline:number}>("SELECT (value->>'piTimeoutMs')::int AS deadline FROM app_settings")).rows).toEqual([{deadline:300_000}]);
    for(const [index,fixture] of fixtures.entries()) {
      expect((await pool.query<{deadline:number}>("SELECT (settings_snapshot->>'piTimeoutMs')::int AS deadline FROM processing_batches WHERE id=$1",[ids[index]])).rows)
        .toEqual([{deadline:fixture.expected}]);
    }
    await pool.query("UPDATE app_settings SET value=jsonb_set(value,'{piTimeoutMs}','900000')");
    await pool.query(sql);
    expect((await pool.query<{deadline:number}>("SELECT (value->>'piTimeoutMs')::int AS deadline FROM app_settings")).rows).toEqual([{deadline:900_000}]);
  });

  it('enforces durable history boundaries and preserves published snapshots', async () => {
    const source = (await pool.query<{ id: string }>(
      "INSERT INTO sources (connector_type, external_id, name) VALUES ('feed', 'test', 'Test') RETURNING id",
    )).rows[0];
    if (!source) throw new Error('Source insert failed');
    const item = (await pool.query<{ id: string; retention_at: Date }>(
      `INSERT INTO source_items (source_id, external_id, published_at)
       VALUES ($1, 'test-item', '2026-01-01') RETURNING id, retention_at`, [source.id],
    )).rows[0];
    if (!item) throw new Error('Item insert failed');
    await pool.query('UPDATE source_items SET retention_at = now(), collected_at = now() WHERE id = $1', [item.id]);
    const retained = await pool.query<{ retention_at: Date }>('SELECT retention_at FROM source_items WHERE id = $1', [item.id]);
    expect(retained.rows[0]?.retention_at).toEqual(item.retention_at);
    const revision = (await pool.query<{ id: string }>(
      `INSERT INTO item_revisions (item_id, revision_number, content_hash, original_text, normalized_text)
       VALUES ($1, 1, 'hash', 'Original', 'Original') RETURNING id`, [item.id],
    )).rows[0];
    const story = (await pool.query<{ id: string }>('INSERT INTO stories DEFAULT VALUES RETURNING id')).rows[0];
    if (!revision || !story) throw new Error('Content insert failed');
    await pool.query('UPDATE source_items SET current_revision_id = $1 WHERE id = $2', [revision.id, item.id]);
    await pool.query(`INSERT INTO story_mentions (revision_id, story_id, text, ordinal)
      VALUES ($1, $2, 'Event', 0)`, [revision.id, story.id]);
    const config = (await pool.query<{ id: string }>(`INSERT INTO embedding_configs
      (config_key, model, endpoint, dimensions, input_version, context_tokens, status)
      VALUES ('test-config', 'test', 'http://localhost', 3, 'v1', 2048, 'active') RETURNING id`)).rows[0];
    if (!config) throw new Error('Configuration insert failed');
    await expect(pool.query(`INSERT INTO embeddings (config_id, story_id, input_hash, embedding)
      VALUES ($1, $2, 'hash', '[1,2]')`, [config.id, story.id])).rejects.toThrow();
    await pool.query(`INSERT INTO embeddings (config_id, story_id, input_hash, embedding)
      VALUES ($1, $2, 'hash', '[1,2,3]')`, [config.id, story.id]);
    const batchSql = `INSERT INTO processing_batches (cutoff_at, settings_snapshot, profile_version, model_version)
      VALUES (now(), '{}', 1, 1) RETURNING id`;
    const batch = (await pool.query<{ id: string }>(batchSql)).rows[0];
    if (!batch) throw new Error('Batch insert failed');
    expect((await pool.query(batchSql)).rowCount).toBe(1); // Waiting batches no longer own the queue.
    const stageSql = "INSERT INTO stage_state (batch_id, revision_id, stage) VALUES ($1, $2, 'extract')";
    await pool.query(stageSql, [batch.id, revision.id]);
    await expect(pool.query(stageSql, [batch.id, revision.id])).rejects.toThrow();
    const content = { headline: 'News', score: 8, details: 'Details', detailsKind: 'summary', sources: [] };
    const snapshot = (await pool.query<{ id: string }>(
      'INSERT INTO publication_snapshots (story_id, content) VALUES ($1, $2) RETURNING id',
      [story.id, JSON.stringify(content)],
    )).rows[0];
    if (!snapshot) throw new Error('Snapshot insert failed');
    await pool.query(`INSERT INTO publications
      (story_id, snapshot_id, destination_id, message_id, callback_id, status)
      VALUES ($1, $2, 'test-destination', '1', 'test-callback', 'published')`, [story.id, snapshot.id]);
    await pool.query('DELETE FROM source_items WHERE id = $1', [item.id]);
    await pool.query('DELETE FROM stories WHERE id = $1', [story.id]);
    expect((await pool.query<{ content: unknown }>('SELECT content FROM publication_snapshots WHERE id = $1', [snapshot.id]))
      .rows[0]?.content).toEqual(content);
    expect((await pool.query<{ message_id: string; story_id: string | null }>(
      "SELECT message_id, story_id FROM publications WHERE callback_id = 'test-callback'",
    )).rows[0]).toEqual({ message_id: '1', story_id: null });
    expect((await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM embeddings')).rows[0]?.count).toBe(0);
  });
});
