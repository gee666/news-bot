import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostgresSourceCollectionStore } from './collection-store.js';
import type { SourceCollectedItem } from './types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `primary_test_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let pool: pg.Pool;
let store: PostgresSourceCollectionStore;
let batch: string;
let source: { id: string };
let close: () => Promise<void>;
const item: SourceCollectedItem = { externalId: 'stable-guid', originalText: '# Article\n$500 25x',
  normalizedText: '# Article\n$500 25x', originalUrl: 'https://example.org/news/release',
  publishedAt: null, editedAt: null, links: [], metadata: { publicationKnown: false } };

describe.skipIf(!databaseUrl)('shared publisher persistence in disposable database', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGOPTIONS = `-c search_path=${schema},public`;
    admin = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=public' });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    const database = await import('../db.js');
    await database.migrate(pool);
    close = () => database.db.end();
    const module = await import('./collection-store.js');
    store = new module.PostgresSourceCollectionStore();
    const sourceResult = await pool.query<{ id: string }>("INSERT INTO sources(connector_type,external_id,name) VALUES('feed','fixture','Fixture') RETURNING id");
    const batchResult = await pool.query<{ id: string }>(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES(now(),'{}',1,1) RETURNING id`);
    const savedSource = sourceResult.rows[0]; const savedBatch = batchResult.rows[0];
    if (!savedSource || !savedBatch) throw new Error('fixture_insert_failed');
    source = savedSource; batch = savedBatch.id;
    await pool.query('INSERT INTO batch_sources(batch_id,source_id) VALUES($1,$2)', [batch, source.id]);
  });
  afterAll(async () => {
    if (close) await close();
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
  });
  it('saves partial progress with genuinely unknown date, unchanged cursor until complete', async () => {
    expect(await store.commitProgress(batch, source, [item], { cutoff: '2026-10-01T12:00:00Z', completedIds: ['stable-guid'] }, false)).toBe(1);
    const saved = await pool.query<{ published_at: Date | null; retention_at: Date; collected_at: Date }>('SELECT published_at,retention_at,collected_at FROM source_items');
    expect(saved.rows[0]?.published_at).toBeNull();
    expect(saved.rows[0]?.retention_at).toEqual(saved.rows[0]?.collected_at);
    expect((await pool.query('SELECT collection_cursor FROM sources')).rows[0]?.collection_cursor).toEqual({});
    expect((await pool.query('SELECT status FROM batch_sources')).rows[0]?.status).toBe('pending');
  });
  it('edits reuse stable item ID and append revisions while keeping retention', async () => {
    const before = await pool.query('SELECT id,retention_at FROM source_items');
    expect(await store.commitProgress(batch, source, [{ ...item, originalText: '# Article\n$500 25x 300tps' }], {}, false)).toBe(1);
    const after = await pool.query('SELECT id,retention_at FROM source_items');
    expect(after.rows).toEqual(before.rows);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM item_revisions')).rows[0]?.count).toBe(2);
  });
  it('unchanged item does not replay, completion updates cursor atomically and resume is no-op', async () => {
    const edited = { ...item, originalText: '# Article\n$500 25x 300tps' };
    expect(await store.commitProgress(batch, source, [edited], { cutoff: '2026-10-01T12:00:00Z' }, true)).toBe(0);
    expect((await pool.query('SELECT status FROM batch_sources')).rows[0]?.status).toBe('completed');
    expect(await store.commitSource(batch, source, [item], {})).toBe(0);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM batch_items')).rows[0]?.count).toBe(2);
  });
  it('publisher backlog checkpoints survive failed batches and cannot regress a newer source cutoff', async () => {
    const configured = (await pool.query<{ id: string }>(`INSERT INTO sources(connector_type,external_id,name,original_url,metadata)
      VALUES('feed','backlog','Backlog','https://example.org/feed',$1::jsonb) RETURNING id`, [
      JSON.stringify({ publisher: 'Publisher', articlePathPrefixes: ['/news/'], maxArticles: 2, unknownPublication: 'skip' }),
    ])).rows[0];
    await pool.query("UPDATE processing_batches SET status='failed' WHERE id=$1", [batch]);
    const nextBatch = (await pool.query<{ id: string }>(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES('2026-10-02T12:00:00Z','{}',1,1) RETURNING id`)).rows[0];
    if (!configured || !nextBatch) throw new Error('fixture_insert_failed');
    await pool.query('INSERT INTO batch_sources(batch_id,source_id) VALUES($1,$2)', [batch, configured.id]);
    const { primaryCursorSchema } = await import('./config.js');
    const checkpoint = primaryCursorSchema.parse({ cutoff: '2026-10-01T12:00:00.000Z', attemptedIds: ['discovered'],
      backlog: [{ id: 'discovered', url: 'https://example.org/news/discovered', title: null,
        publishedAt: null, discoveredAt: '2026-10-01T12:00:00.000Z', failures: 1,
        nextAttemptAt: '2026-10-01T13:00:00.000Z', lastErrorCode: 'primary_article_restricted_http_403' }] });
    await store.commitProgress(batch, configured, [], checkpoint, false);
    await pool.query("UPDATE batch_sources SET status='failed' WHERE batch_id=$1 AND source_id=$2", [batch, configured.id]);
    expect((await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [configured.id])).rows[0]?.collection_cursor).toEqual(checkpoint);
    const { preparePrimarySources } = await import('./repository.js');
    const prepared = (await preparePrimarySources(nextBatch.id)).find(value => value.id === configured.id);
    expect(prepared?.cursor).toEqual(checkpoint);
    const newer = { ...checkpoint, cutoff: '2026-10-02T12:00:00.000Z', attemptedIds: [] };
    await store.commitProgress(nextBatch.id, configured, [], newer, false);
    await store.commitProgress(batch, configured, [], checkpoint, false);
    expect((await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [configured.id])).rows[0]?.collection_cursor).toEqual(newer);
    await pool.query('UPDATE sources SET collection_config_version=collection_config_version+1 WHERE id=$1', [configured.id]);
    const beforeStale = (await pool.query('SELECT cursor_after,status FROM batch_sources WHERE batch_id=$1 AND source_id=$2',
      [nextBatch.id, configured.id])).rows;
    await expect(store.commitProgress(nextBatch.id, { ...configured, configVersion: 1 }, [item], checkpoint, false))
      .rejects.toMatchObject({ code: 'primary_store_config_changed' });
    expect((await pool.query('SELECT cursor_after,status FROM batch_sources WHERE batch_id=$1 AND source_id=$2',
      [nextBatch.id, configured.id])).rows).toEqual(beforeStale);
    expect((await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [configured.id])).rows[0]?.collection_cursor).toEqual(newer);
    await pool.query("UPDATE batch_sources SET status='completed' WHERE source_id=$1", [configured.id]);
    await pool.query('UPDATE sources SET enabled=false WHERE id=$1', [configured.id]);
  });
  it('legacy publisher configuration fails only its source while preserving saved items and cursor', async () => {
    const invalid = (await pool.query<{ id: string }>(`INSERT INTO sources(connector_type,external_id,name)
      VALUES('website','legacy','Legacy') RETURNING id`)).rows[0];
    const valid = (await pool.query<{ id: string }>(`INSERT INTO sources(connector_type,external_id,name,original_url,metadata)
      VALUES('feed','configured','Configured','https://example.org/feed',$1::jsonb) RETURNING id`, [
      JSON.stringify({ publisher: 'Publisher', articlePathPrefixes: ['/news/'], maxArticles: 2, unknownPublication: 'skip' }),
    ])).rows[0];
    if (!invalid || !valid) throw new Error('fixture_insert_failed');
    const cursor = { completedIds: ['stable-guid'], cutoff: '2026-10-01T12:00:00Z' };
    await pool.query('INSERT INTO batch_sources(batch_id,source_id,cursor_after) VALUES($1,$2,$3::jsonb)',
      [batch, invalid.id, JSON.stringify(cursor)]);
    expect(await store.commitProgress(batch, invalid, [{ ...item, externalId: 'legacy-saved' }], cursor, false)).toBe(1);
    const before = (await pool.query('SELECT id,retention_at,current_revision_id FROM source_items ORDER BY id')).rows;
    const { preparePrimarySources } = await import('./repository.js');
    expect((await preparePrimarySources(batch)).map(value => value.id)).toEqual([valid.id]);
    expect((await pool.query('SELECT status,error_code,cursor_after FROM batch_sources WHERE batch_id=$1 AND source_id=$2',
      [batch, invalid.id])).rows[0]).toEqual({ status: 'failed', error_code: 'primary_source_invalid_config', cursor_after: cursor });
    expect((await pool.query('SELECT id,retention_at,current_revision_id FROM source_items ORDER BY id')).rows).toEqual(before);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM batch_items')).rows[0]?.count).toBe(3);
  });
});
