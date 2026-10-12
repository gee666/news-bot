import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CrawlerPage } from '../pipeline/crawler-client.js';
import type { PostgresSourceCollectionStore } from './collection-store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = 'publisher_refresh_'+randomUUID().replaceAll('-', '');
let admin: pg.Pool;
let pool: pg.Pool;
let close: () => Promise<void>;
let store: PostgresSourceCollectionStore;
let refresh: typeof import('./refresh.js').refreshPublisherItem;
let reader: typeof import('./collector.js').publisherReader;
let itemId: string;
let sourceId: string;
let batchId: string;
let oldRevisionId: string;
const url = 'https://example.org/news/release';
const date = new Date('2026-09-01T12:00:00Z');
const page: CrawlerPage = { url, canonicalUrl: url, title: 'Article', content: 'Clean body [Code](https://github.com/NVIDIA/structured-data-models)',
  access: 'public', publishedAt: '2026-10-02T12:00:00Z', metadata: { status: 200, cleaning: 'readability' } };

async function history() {
  return {
    item: (await pool.query('SELECT id,source_id,external_id,original_url,published_at,retention_at FROM source_items WHERE id=$1', [itemId])).rows,
    source: (await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [sourceId])).rows,
    batchSource: (await pool.query('SELECT * FROM batch_sources WHERE batch_id=$1 AND source_id=$2', [batchId, sourceId])).rows,
    oldRevision: (await pool.query('SELECT * FROM item_revisions WHERE id=$1', [oldRevisionId])).rows,
    oldLinks: (await pool.query('SELECT * FROM item_links WHERE revision_id=$1 ORDER BY id', [oldRevisionId])).rows,
  };
}

describe.skipIf(!databaseUrl)('operator publisher refresh in disposable database', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGOPTIONS = '-c search_path='+schema+',public';
    admin = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=public' });
    await admin.query('CREATE SCHEMA '+schema);
    pool = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path='+schema+',public' });
    const database = await import('../db.js');
    await database.migrate(pool); close = () => database.db.end();
    store = new (await import('./collection-store.js')).PostgresSourceCollectionStore();
    refresh = (await import('./refresh.js')).refreshPublisherItem;
    reader = (await import('./collector.js')).publisherReader;
    const source = (await pool.query<{ id: string }>(`INSERT INTO sources(connector_type,external_id,name,original_url,metadata,access)
      VALUES('feed','https://example.org/feed','Publisher','https://example.org/feed',$1::jsonb,'public') RETURNING id`,
    [JSON.stringify({ publisher: 'Publisher', articlePathPrefixes: ['/news/'], maxArticles: 1, unknownPublication: 'skip' })])).rows[0];
    const batch = (await pool.query<{ id: string }>(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES('failed',now(),'{}',1,1) RETURNING id`)).rows[0];
    if (!source || !batch) throw new Error('fixture_missing');
    sourceId = source.id; batchId = batch.id;
    await pool.query('INSERT INTO batch_sources(batch_id,source_id) VALUES($1,$2)', [batchId, sourceId]);
    const raw = '# Article\nRaw body with avatar';
    await store.commitSource(batchId, source, [{ externalId: 'GUID-1', originalUrl: url, publishedAt: date, editedAt: null,
      originalText: raw, normalizedText: raw, metadata: { connectorKind: 'feed', publisher: 'Publisher', canonicalUrl: url, publicationBasis: 'feed' },
      links: [{ url: 'https://cdn.example/avatar.jpg)](https://example.org/person', anchorText: 'avatar', startOffset: 0, endOffset: 6, metadata: {} }],
    }], { cutoff: date.toISOString(), completedIds: ['GUID-1'], unknownIds: [] });
    const item = (await pool.query<{ id: string; current_revision_id: string }>('SELECT id,current_revision_id FROM source_items WHERE source_id=$1', [sourceId])).rows[0];
    if (!item) throw new Error('fixture_missing');
    itemId = item.id; oldRevisionId = item.current_revision_id;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (close) await close();
    if (pool) await pool.end();
    if (admin) { await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end(); }
  });
  it('appends the repaired revision and existing-batch membership without touching old links, dates, GUID or completed-source cursor', async () => {
    const before = await history();
    const crawl = vi.spyOn(reader, 'article').mockResolvedValue(page);
    const result = await refresh(itemId, batchId);
    expect(crawl).toHaveBeenCalledWith(url);
    expect(result).toMatchObject({ itemId, changed: true });
    expect(result.revisionId).not.toBe(oldRevisionId);
    expect(await history()).toEqual(before);
    expect((await pool.query('SELECT current_revision_id FROM source_items WHERE id=$1', [itemId])).rows[0]?.current_revision_id).toBe(result.revisionId);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM item_revisions WHERE item_id=$1', [itemId])).rows[0]?.count).toBe(2);
    expect((await pool.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId, result.revisionId])).rows[0]?.status).toBe('pending');
    expect((await pool.query('SELECT url FROM item_links WHERE revision_id=$1', [result.revisionId])).rows.map(row => row.url))
      .toEqual(['https://github.com/NVIDIA/structured-data-models']);
  });
  it('unchanged refresh is a true no-op, including membership and metadata', async () => {
    const before = (await pool.query('SELECT * FROM source_items WHERE id=$1', [itemId])).rows;
    const memberships = (await pool.query('SELECT * FROM batch_items WHERE batch_id=$1 ORDER BY revision_id', [batchId])).rows;
    expect(await refresh(itemId, batchId)).toMatchObject({ itemId, changed: false });
    expect((await pool.query('SELECT * FROM source_items WHERE id=$1', [itemId])).rows).toEqual(before);
    expect((await pool.query('SELECT * FROM batch_items WHERE batch_id=$1 ORDER BY revision_id', [batchId])).rows).toEqual(memberships);
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM item_revisions WHERE item_id=$1', [itemId])).rows[0]?.count).toBe(2);
  });
  it('preserves genuinely unknown publication and timestamp precision during historical repair', async () => {
    await pool.query('UPDATE source_items SET published_at=NULL WHERE id=$1', [itemId]);
    vi.spyOn(reader, 'article').mockResolvedValueOnce({ ...page, content: page.content+' More body.' });
    expect(await refresh(itemId, batchId)).toMatchObject({ changed: true });
    expect((await pool.query('SELECT published_at FROM source_items WHERE id=$1', [itemId])).rows[0]?.published_at).toBeNull();
    await pool.query("UPDATE source_items SET published_at='2026-09-01T12:00:00.123456Z' WHERE id=$1", [itemId]);
    const before = (await pool.query('SELECT published_at::text AS value FROM source_items WHERE id=$1', [itemId])).rows;
    vi.spyOn(reader, 'article').mockResolvedValueOnce({ ...page, content: page.content+' Precise repair.' });
    expect(await refresh(itemId, batchId)).toMatchObject({ changed: true });
    expect((await pool.query('SELECT published_at::text AS value FROM source_items WHERE id=$1', [itemId])).rows).toEqual(before);
  });
  it('rejects missing batch membership and durable running work before fetching', async () => {
    const crawl = vi.spyOn(reader, 'article'); crawl.mockClear();
    await pool.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status) VALUES($1,$2,'refresh-guard','running')`, [batchId, oldRevisionId]);
    await expect(refresh(itemId, batchId)).rejects.toThrow('publisher_refresh_work_running');
    expect(crawl).not.toHaveBeenCalled();
    await pool.query("DELETE FROM stage_state WHERE batch_id=$1 AND stage='refresh-guard'", [batchId]);
    await expect(refresh(randomUUID(), batchId)).rejects.toThrow('publisher_refresh_invalid_item');
  });
  it('rejects collection/processing batches before fetching', async () => {
    const crawl = vi.spyOn(reader, 'article'); crawl.mockClear();
    await pool.query("UPDATE processing_batches SET status='processing' WHERE id=$1", [batchId]);
    await expect(refresh(itemId, batchId)).rejects.toThrow('publisher_refresh_batch_not_parked');
    expect(crawl).not.toHaveBeenCalled();
    await pool.query("UPDATE processing_batches SET status='waiting' WHERE id=$1", [batchId]);
  });
  it('rejects source kind/URL drift, nonpublic URLs and article redirects', async () => {
    await pool.query("UPDATE sources SET connector_type='website' WHERE id=$1", [sourceId]);
    await expect(refresh(itemId, batchId)).rejects.toThrow('publisher_refresh_identity_drift');
    await pool.query("UPDATE sources SET connector_type='feed' WHERE id=$1", [sourceId]);
    await pool.query("UPDATE source_items SET original_url='http://127.0.0.1/private' WHERE id=$1", [itemId]);
    await expect(refresh(itemId, batchId)).rejects.toThrow();
    await pool.query('UPDATE source_items SET original_url=$2 WHERE id=$1', [itemId, url]);
    vi.spyOn(reader, 'article').mockResolvedValueOnce({ ...page, canonicalUrl: 'https://example.org/news/different' });
    await expect(refresh(itemId, batchId)).rejects.toThrow('publisher_refresh_invalid_result');
    vi.spyOn(reader, 'article').mockImplementationOnce(async () => {
      await pool.query("UPDATE sources SET name='Changed during fetch' WHERE id=$1", [sourceId]);
      return page;
    });
    await expect(refresh(itemId, batchId)).rejects.toThrow('publisher_refresh_identity_drift');
  });
});
