import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
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

  it('owns its migration ledger instead of inheriting a fallback schema ledger', async () => {
    const rows=await pool.query<{schema:string}>(`SELECT n.nspname AS schema FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='schema_migrations'::regclass`);
    expect(rows.rows).toEqual([{schema}]);
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

  it('retires unresolved delivery without changing published messages', async () => {
    const client = await pool.connect();
    const legacy = `legacy_${randomUUID().replaceAll('-','')}`;
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA ${legacy}`);
      await client.query(`SET LOCAL search_path=${legacy},public`);
      const directory = new URL('../migrations/',import.meta.url);
      const names = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/u.test(name) && name < '207_').sort();
      for (const name of names) await client.query(await readFile(new URL(name,directory),'utf8'));
      const snapshot = (await client.query<{id:string}>(`INSERT INTO publication_snapshots(content)
        VALUES('{"headline":"News","score":8,"details":"Facts","detailsKind":"summary","sources":[]}') RETURNING id`)).rows[0];
      if (!snapshot) throw new Error('Missing migration fixture');
      for (const [index,kind,status] of [[1,'text','uncertain'],[2,'album','uncertain'],[3,'text','published']] as const) {
        const publication = (await client.query<{id:string}>(`INSERT INTO publications(snapshot_id,destination_id,delivery_kind,status,message_id)
          VALUES($1,$2,$3,$4,$5) RETURNING id`,[snapshot.id,`-100${index}`,kind,status,status==='published'?'100':null])).rows[0];
        if (!publication) throw new Error('Missing publication fixture');
        await client.query(`INSERT INTO publication_destination_reservations(destination_id,publication_id) VALUES($1,$2)`,[`-100${index}`,publication.id]);
        if (status === 'uncertain') await client.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
          VALUES($1,'telegram-bot','send',1,'unknown')`,[publication.id]);
        if (index === 2) await client.query(`INSERT INTO publication_media_batches(publication_id,batch_number,status)
          VALUES($1,0,'unknown')`,[publication.id]);
      }
      await client.query(await readFile(new URL('207_simplify_publishing.sql',directory),'utf8'));
      expect((await client.query('SELECT status,error_code,message_id FROM publications ORDER BY destination_id')).rows).toEqual([
        {status:'failed',error_code:'legacy_unresolved',message_id:null},
        {status:'failed',error_code:'legacy_unresolved',message_id:null},
        {status:'published',error_code:null,message_id:'100'},
      ]);
      expect((await client.query('SELECT status,error_code FROM publication_media_batches')).rows)
        .toEqual([{status:'failed',error_code:'legacy_unresolved'}]);
      expect((await client.query('SELECT status,error_code FROM request_attempts')).rows)
        .toEqual(Array.from({length:2},()=>({status:'failed',error_code:'legacy_unresolved'})));
      expect((await client.query('SELECT destination_id FROM publication_destination_reservations')).rows).toEqual([{destination_id:'-1003'}]);
      expect((await client.query(`SELECT to_regclass($1) AS text_parts,to_regclass($2) AS navigation_parts`,
        [`${legacy}.publication_text_parts`,`${legacy}.publication_navigation_parts`])).rows)
        .toEqual([{text_parts:null,navigation_parts:null}]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  },30_000);

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
