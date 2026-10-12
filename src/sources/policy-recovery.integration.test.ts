import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primaryCursorSchema, type PrimarySource } from './config.js';
import type { PostgresSourceCollectionStore } from './collection-store.js';
import type { SourceCollectedItem } from './types.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = 'publisher_policy_'+randomUUID().replaceAll('-', '');
const cutoff = new Date('2026-10-01T12:00:00.000Z');
let admin: pg.Pool;
let pool: pg.Pool;
let close: () => Promise<void>;
let repository: typeof import('./repository.js');
let store: PostgresSourceCollectionStore;
let source: PrimarySource;
let batchId: string;
const articleUrl = (id: string) => 'https://example.org/news/'+id;

async function waitForSourceLocks(count: number): Promise<void> {
  const deadline = Date.now() + 3000;
  do {
    const result = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='news-bot'
        AND wait_event_type='Lock' AND query LIKE '%FROM sources%'`);
    if ((result.rows[0]?.count ?? 0) >= count) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error('source_lock_wait_not_observed');
}

describe.skipIf(!databaseUrl)('publisher policy recovery in isolated SQL database', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGOPTIONS = `-c search_path=${schema},public -c lock_timeout=5000`;
    admin = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=public' });
    await admin.query('CREATE SCHEMA '+schema);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public -c lock_timeout=5000` });
    const database = await import('../db.js');
    await database.migrate(pool);
    close = () => database.db.end();
    repository = await import('./repository.js');
    store = new (await import('./collection-store.js')).PostgresSourceCollectionStore();
  });
  beforeEach(async () => {
    await pool.query("UPDATE processing_batches SET status='completed' WHERE status IN ('collecting','processing','waiting')");
    await pool.query('UPDATE sources SET enabled=false');
    const added = await repository.addPrimarySource({ kind: 'feed', name: 'Publisher', publisher: 'Publisher',
      url: 'https://example.org/feed/'+randomUUID(), articlePathPrefixes: ['/news/'], maxArticles: 3,
      backlogLimit: 400, retryDelayMinutes: 90, feedDateRole: 'submission', unknownPublication: 'skip' });
    const batch = (await pool.query<{ id: string }>(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES($1,'{}',1,1) RETURNING id`, [cutoff])).rows[0];
    if (!batch) throw new Error('fixture_batch_missing');
    batchId = batch.id;
    const prepared = (await repository.preparePrimarySources(batchId)).find(value => value.id === added.id);
    if (!prepared) throw new Error('fixture_source_missing');
    source = prepared;
  });
  afterAll(async () => {
    if (close) await close();
    if (pool) await pool.end();
    if (admin) { await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end(); }
  });

  it('recovers legacy skipped IDs in source and unfinished batch without replaying retained undated items or changing budgets', async () => {
    const legacy = { cutoff: cutoff.toISOString(), completedIds: ['skipped', 'collected'], unknownIds: ['skipped', 'collected'],
      seen: ['skipped', 'collected'].map(id => ({ id, checkedAt: cutoff.toISOString() })) };
    const retained: SourceCollectedItem = { externalId: 'collected', originalUrl: articleUrl('collected'),
      originalText: 'Retained article', normalizedText: 'Retained article', publishedAt: null, editedAt: null,
      links: [], metadata: { connectorKind: 'feed', publicationKnown: false } };
    await store.commitProgress(batchId, source, [retained], legacy, false);
    await pool.query('UPDATE sources SET collection_cursor=$2::jsonb WHERE id=$1', [source.id, JSON.stringify(legacy)]);
    const before = (await pool.query('SELECT id,retention_at,current_revision_id FROM source_items WHERE source_id=$1', [source.id])).rows;
    const changed = await repository.editPrimarySource(source.id, { unknownPublication: 'collect_once' });
    expect(changed).toMatchObject({ unknownPublication: 'collect_once', maxArticles: 3, backlogLimit: 400,
      retryDelayMinutes: 90, feedDateRole: 'submission', identityLocked: true,
      cursor: { completedIds: ['collected'], unknownIds: ['collected'], skippedUnknownIds: [], unknownPolicy: 'collect_once' } });
    const recovered = (await pool.query('SELECT cursor_after FROM batch_sources WHERE batch_id=$1 AND source_id=$2', [batchId, source.id])).rows[0]?.cursor_after;
    expect(recovered).toMatchObject({ completedIds: ['collected'], unknownIds: ['collected'],
      seen: [{ id: 'collected', checkedAt: cutoff.toISOString() }] });
    await expect(store.commitProgress(batchId, source, [], primaryCursorSchema.parse(legacy), false))
      .rejects.toMatchObject({ code: 'primary_store_config_changed' });
    expect((await pool.query('SELECT id,retention_at,current_revision_id FROM source_items WHERE source_id=$1', [source.id])).rows).toEqual(before);
    expect((await pool.query('SELECT cursor_after FROM batch_sources WHERE batch_id=$1 AND source_id=$2', [batchId, source.id])).rows[0]?.cursor_after).toEqual(recovered);
    const fresh = (await repository.preparePrimarySources(batchId)).find(value => value.id === source.id);
    if (!fresh) throw new Error('fixture_source_missing');
    const article = vi.fn(async (url: string) => ({ url, canonicalUrl: url, title: null, content: 'Recovered undated article',
      access: 'public' as const, metadata: {} }));
    const { collectPublisher } = await import('./collector.js');
    expect(await collectPublisher({ index: async () => ['skipped', 'collected'].map(id => ({ id, url: articleUrl(id),
      title: null, publishedAt: null })), article }, store, batchId, fresh, cutoff)).toBe(1);
    expect(article).toHaveBeenCalledExactlyOnceWith(articleUrl('skipped'));
    expect((await pool.query('SELECT id,retention_at,current_revision_id FROM source_items WHERE source_id=$1 AND external_id=$2',
      [source.id, 'collected'])).rows).toEqual(before);
  });

  it('serializes a concurrent policy edit before a stale checkpoint without deadlocking or undoing recovery', async () => {
    const skipped = primaryCursorSchema.parse({ cutoff: cutoff.toISOString(), unknownPolicy: 'skip',
      completedIds: ['skipped'], skippedUnknownIds: ['skipped'], seen: [{ id: 'skipped', checkedAt: cutoff.toISOString() }],
      backlog: [{ id: 'skipped', url: articleUrl('skipped'), title: null, publishedAt: null, discoveredAt: cutoff.toISOString() }] });
    await store.commitProgress(batchId, source, [], skipped, false);
    const locker = await pool.connect();
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [source.id]);
      const edit = repository.editPrimarySource(source.id, { unknownPublication: 'collect_once' }).catch((error: unknown) => error);
      await waitForSourceLocks(1);
      const stale = store.commitProgress(batchId, source, [], skipped, false).catch((error: unknown) => error);
      await waitForSourceLocks(2);
      await locker.query('COMMIT');
      expect(await edit).toMatchObject({ unknownPublication: 'collect_once',
        cursor: { skippedUnknownIds: [], completedIds: [], unknownPolicy: 'collect_once' } });
      expect(await stale).toMatchObject({ code: 'primary_store_config_changed' });
      const saved = (await pool.query('SELECT collection_cursor,collection_config_version FROM sources WHERE id=$1', [source.id])).rows[0];
      expect(saved).toMatchObject({ collection_config_version: 2,
        collection_cursor: { skippedUnknownIds: [], completedIds: [], unknownPolicy: 'collect_once' } });
      expect((await pool.query('SELECT cursor_after FROM batch_sources WHERE batch_id=$1 AND source_id=$2',
        [batchId, source.id])).rows[0]?.cursor_after).toEqual(saved?.collection_cursor);
    } finally { await locker.query('ROLLBACK'); locker.release(); }
  });
});
