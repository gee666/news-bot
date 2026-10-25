import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CrawlerPage } from '../pipeline/crawler-client.js';
import type { PrimaryReader } from './collector.js';
import type { PostgresSourceCollectionStore } from './collection-store.js';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]) }));
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = 'publisher_management_'+randomUUID().replaceAll('-', '');
const input = { kind: 'feed', name: 'Publisher', publisher: 'Publisher', url: 'https://example.org/feed',
  articlePathPrefixes: ['/news/'], maxArticles: 2 };
let admin: pg.Pool;
let pool: pg.Pool;
let close: () => Promise<void>;
let repository: typeof import('./repository.js');
let store: PostgresSourceCollectionStore;

async function createBatch(cutoff: Date): Promise<string> {
  await pool.query("UPDATE processing_batches SET status='completed' WHERE status IN ('collecting','processing','waiting')");
  const result = await pool.query<{ id: string }>(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES($1,'{}',1,1) RETURNING id`, [cutoff]);
  const row = result.rows[0];
  if (!row) throw new Error('fixture_insert_failed');
  return row.id;
}

describe.skipIf(!databaseUrl)('publisher management and progress in disposable database', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.PGOPTIONS = '-c search_path='+schema+',public';
    admin = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path=public' });
    await admin.query('CREATE SCHEMA '+schema);
    pool = new pg.Pool({ connectionString: databaseUrl, options: '-c search_path='+schema+',public' });
    const database = await import('../db.js');
    await database.migrate(pool);
    close = () => database.db.end();
    repository = await import('./repository.js');
    store = new (await import('./collection-store.js')).PostgresSourceCollectionStore();
  });
  afterAll(async () => {
    if (close) await close();
    if (pool) await pool.end();
    if (admin) { await admin.query('DROP SCHEMA '+schema+' CASCADE'); await admin.end(); }
  });

  it('persists first two, next two and a later edit with stable retention and a bounded per-batch budget', async () => {
    const added = await repository.addPrimarySource(input);
    if (added.configState !== 'valid') throw new Error('fixture_invalid');
    const cutoff = new Date('2026-10-01T12:00:00Z');
    const entries = [4, 3, 2, 1].map(id => ({ id: 'guid'+id, url: 'https://example.org/news/'+id, title: null,
      publishedAt: new Date(cutoff.getTime() - (5 - id) * 3600000) }));
    let edited = false;
    const reader: PrimaryReader = { index: async () => entries, article: vi.fn(async (url: string): Promise<CrawlerPage> => ({
      url, canonicalUrl: url, title: null, content: edited && url.endsWith('/1') ? 'Price $600' : 'Price $500',
      access: 'public', publishedAt: null, metadata: { status: 200 },
    })) };
    const { collectPublisher } = await import('./collector.js');
    let originalRetention: unknown;
    for (let index = 0; index < 3; index++) {
      edited = index === 2;
      const time = new Date(cutoff.getTime() + index * 3600000);
      const batch = await createBatch(time);
      const sources = await repository.preparePrimarySources(batch);
      const source = sources.find(value => value.id === added.id);
      if (!source) throw new Error('fixture_source_missing');
      expect(await collectPublisher(reader, store, batch, source, time)).toBe(index === 2 ? 1 : 2);
      expect(vi.mocked(reader.article).mock.calls.slice(index * 2).map(call => call[0])).toEqual(
        (index === 0 ? [1, 2] : index === 1 ? [3, 4] : [1, 2]).map(id => 'https://example.org/news/'+id));
      const saved = (await pool.query('SELECT retention_at FROM source_items WHERE source_id=$1 AND external_id=$2',
        [added.id, 'guid1'])).rows[0]?.retention_at;
      if (index === 0) originalRetention = saved;
      else expect(saved).toEqual(originalRetention);
      expect((await pool.query('SELECT COUNT(*)::int AS count FROM batch_items WHERE batch_id=$1', [batch])).rows[0]?.count)
        .toBe(index === 2 ? 1 : 2);
    }
    expect((await pool.query('SELECT COUNT(*)::int AS count FROM source_items WHERE source_id=$1', [added.id])).rows[0]?.count).toBe(4);
    expect((await pool.query(`SELECT COUNT(*)::int AS count FROM item_revisions r JOIN source_items i ON i.id=r.item_id
      WHERE i.source_id=$1`, [added.id])).rows[0]?.count).toBe(5);
  });

  it('rejects changed URL/kind after ingestion, permits other edits and locks identity after cleanup', async () => {
    const source = (await repository.listPrimarySources()).find(value => value.configState === 'valid');
    if (!source || source.configState !== 'valid') throw new Error('fixture_missing');
    expect(source.identityLocked).toBe(true);
    const before = (await pool.query('SELECT external_id,current_revision_id,original_url FROM source_items WHERE source_id=$1 ORDER BY id',
      [source.id])).rows;
    for (const patch of [{ url: 'https://example.org/feed-b' }, { kind: 'website' }, { url: 'https://example.org/feed/' }]) {
      await expect(repository.editPrimarySource(source.id, patch)).rejects.toThrow('primary_source_identity_locked');
    }
    expect((await repository.editPrimarySource(source.id, { name: 'Renamed', enabled: false }))).toMatchObject({
      configState: 'valid', name: 'Renamed', enabled: false, identityLocked: true,
    });
    expect((await pool.query('SELECT external_id,current_revision_id,original_url FROM source_items WHERE source_id=$1 ORDER BY id',
      [source.id])).rows).toEqual(before);
    await pool.query('DELETE FROM source_items WHERE source_id=$1', [source.id]);
    await expect(repository.editPrimarySource(source.id, { url: 'https://example.org/feed-b' }))
      .rejects.toThrow('primary_source_identity_locked');
    const replacement = await repository.addPrimarySource({ ...input, url: 'https://example.org/feed-b' });
    expect(replacement.id).not.toBe(source.id);
    expect(replacement.identityLocked).toBe(false);
  });

  it('allows identity changes before ingestion, resets progress and preserves the source UUID', async () => {
    const empty = await repository.addPrimarySource({ ...input, url: 'https://example.org/empty' });
    await pool.query('UPDATE sources SET collection_cursor=$2::jsonb WHERE id=$1',
      [empty.id, JSON.stringify({ cutoff: '2026-10-01T12:00:00Z', completedIds: ['examined-not-ingested'] })]);
    const changed = await repository.editPrimarySource(empty.id, { kind: 'website', url: 'https://example.org/unused-site' });
    expect(changed).toMatchObject({ configState: 'valid', id: empty.id, identityLocked: false,
      kind: 'website', url: 'https://example.org/unused-site' });
    expect((await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [empty.id])).rows[0]?.collection_cursor).toEqual({});
  });

  it('stores all actual Markdown destinations but admits only reference policy to evidence queries', async () => {
    const added = await repository.addPrimarySource({ ...input, url: 'https://example.org/links-feed' });
    if (added.configState !== 'valid') throw new Error('fixture_missing');
    const { collectPublisher } = await import('./collector.js');
    const { evidenceLinkSql } = await import('./links.js');
    const cutoff = new Date('2026-10-01T12:00:00Z');
    const batch = await createBatch(cutoff);
    const source = (await repository.preparePrimarySources(batch)).find(value => value.id === added.id);
    if (!source) throw new Error('fixture_missing');
    const content = `# Release
[![avatar](https://cdn.example/avatar.jpg)](https://example.org/profile)
[Code][repo]
[Weights](https://example.org/weights)

[repo]: https://github.com/NVIDIA/structured-data-models

## Share
[Social](https://social.example/post)`;
    const reader: PrimaryReader = { index: async () => [{ id: 'linked', url: 'https://example.org/news/linked',
      title: 'Release', publishedAt: cutoff }], article: async url => ({ url, canonicalUrl: url, title: null,
      content, access: 'public', publishedAt: null, metadata: { status: 200 } }) };
    expect(await collectPublisher(reader, store, batch, source, cutoff)).toBe(1);
    const rows = await pool.query<{ url: string; metadata: Record<string, unknown> }>(`SELECT l.url,l.metadata FROM item_links l
      JOIN item_revisions r ON r.id=l.revision_id JOIN source_items i ON i.id=r.item_id WHERE i.source_id=$1`, [added.id]);
    expect(rows.rows).toHaveLength(6);
    expect(rows.rows.some(row => row.url.includes(')]('))).toBe(false);
    const eligible = await pool.query<{ url: string }>(`SELECT l.url FROM item_links l
      JOIN item_revisions r ON r.id=l.revision_id JOIN source_items i ON i.id=r.item_id WHERE i.source_id=$1 AND ${evidenceLinkSql}
      ORDER BY l.url`, [added.id]);
    expect(eligible.rows.map(row => row.url)).toEqual(['https://example.org/weights', 'https://github.com/NVIDIA/structured-data-models']);
  });

  it('enables external articles on one existing aggregator feed and retains policy on later edits', async () => {
    const added = await repository.addPrimarySource({ ...input, name: 'Hacker News', publisher: 'Hacker News',
      url: 'https://hnrss.org/newest', articlePathPrefixes: ['/'] });
    expect(added).toMatchObject({ configState: 'valid', articleLinkPolicy: 'same_host' });
    const updated = await repository.editPrimarySource(added.id, { articleLinkPolicy: 'external' });
    expect(updated).toMatchObject({ id: added.id, configState: 'valid', articleLinkPolicy: 'external' });
    const cutoff = new Date('2026-10-01T12:00:00Z');
    const batch = await createBatch(cutoff);
    const source = (await repository.preparePrimarySources(batch)).find(value => value.id === added.id);
    if (!source) throw new Error('fixture_missing');
    expect(source.articleLinkPolicy).toBe('external');
    const { collectPublisher } = await import('./collector.js');
    const { parseFeed } = await import('./feed.js');
    const articleUrl = 'https://example.org/aggregated-release';
    const reader: PrimaryReader = {
      index: async config => parseFeed('<rss><channel><item><guid>hn-42</guid><link>' + articleUrl +
        '</link><pubDate>Thu, 01 Oct 2026 11:00:00 GMT</pubDate></item></channel></rss>', config),
      article: async url => ({ url, canonicalUrl: 'https://www.example.org/aggregated-release',
        title: 'Release', content: 'Full external article read.', access: 'public', metadata: { status: 200 } }),
    };
    expect(await collectPublisher(reader, store, batch, source, cutoff)).toBe(1);
    const before = (await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [added.id])).rows[0];
    expect(await repository.editPrimarySource(added.id, { enabled: false })).toMatchObject({
      configState: 'valid', articleLinkPolicy: 'external', enabled: false, identityLocked: true,
    });
    expect((await pool.query('SELECT collection_cursor FROM sources WHERE id=$1', [added.id])).rows[0]).toEqual(before);
    const saved = await pool.query('SELECT original_url FROM source_items WHERE source_id=$1', [added.id]);
    expect(saved.rows).toEqual([{ original_url: articleUrl }]);
    await repository.editPrimarySource(added.id, { articleLinkPolicy: 'same_host' });
    expect((await repository.listPrimarySources()).find(value => value.id === added.id)).toMatchObject({ articleLinkPolicy: 'same_host' });
  });

  it('lists a malformed legacy row safely, patches valid rows independently and disables the legacy row', async () => {
    const bad = (await pool.query<{ id: string }>(`INSERT INTO sources(connector_type,external_id,name,original_url,metadata,collection_cursor)
      VALUES('website','legacy','Legacy','https://user:private-key@example.org/news',$1::jsonb,$2::jsonb) RETURNING id`,
    [JSON.stringify({ publisher: 42, secret: 'private-key' }), JSON.stringify({ invalid: 'private-key' })])).rows[0];
    if (!bad) throw new Error('fixture_missing');
    const list = await repository.listPrimarySources();
    expect(list.find(value => value.id === bad.id)).toEqual({ id: bad.id, kind: 'website', name: 'Legacy',
      url: null, enabled: true, identityLocked: false, configState: 'invalid', errorCode: 'primary_source_invalid_config' });
    expect(JSON.stringify(list)).not.toContain('private-key');
    const valid = list.find(value => value.configState === 'valid' && !value.identityLocked);
    if (!valid) throw new Error('fixture_missing');
    expect(await repository.editPrimarySource(valid.id, { name: 'Still editable' })).toMatchObject({
      configState: 'valid', name: 'Still editable',
    });
    const before = (await pool.query('SELECT metadata,collection_cursor,original_url FROM sources WHERE id=$1', [bad.id])).rows;
    await expect(repository.editPrimarySource(bad.id, { enabled: true })).rejects.toThrow('primary_source_invalid_config');
    expect(await repository.editPrimarySource(bad.id, { enabled: false })).toMatchObject({ configState: 'invalid', enabled: false });
    expect((await pool.query('SELECT metadata,collection_cursor,original_url FROM sources WHERE id=$1', [bad.id])).rows).toEqual(before);
    expect((await repository.listPrimarySources()).find(value => value.id === bad.id)?.enabled).toBe(false);
  });
});
