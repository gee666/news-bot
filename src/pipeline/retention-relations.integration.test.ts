import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `retention_relations_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let cleanup: typeof import('./retention.js').cleanup;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql, values)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture ID');
  return id;
}
async function expiredItem(text: string) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Retention fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'1',$2,now()-interval '30 days') RETURNING id`, [source, `https://example.org/${source}`]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  return { item, revision };
}
async function expiredEvidence() {
  return one(`INSERT INTO evidence_documents(url,access,expires_at,fetched_at)
    VALUES('https://example.org/archived-page','public',now()-interval '1 day',now()-interval '30 days') RETURNING id`);
}

describe.skipIf(!databaseUrl)('retention of source-only and archived merge dependencies', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl ?? '');
    url.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', url.toString());
    database = await import('../db.js');
    await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
    ({ cleanup } = await import('./retention.js'));
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it.each(['digest', 'batch-mention', 'batch-source-only'] as const)(
    'protects only %s dependencies until completion, preserving publication snapshots and aliases', async mode => {
      const story = await one("INSERT INTO stories(status) VALUES('processing') RETURNING id");
      const article = await expiredItem('Original release');
      await database.db.query(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal)
        VALUES($1,$2,'Original release',0)`, [article.revision, story]);
      const recap = await expiredItem('Source-only release recap');
      const link = await one(`INSERT INTO item_links(revision_id,url)
        VALUES($1,'https://vendor.example/recap') RETURNING id`, [recap.revision]);
      await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
        VALUES($1,$2,'relevant','test',1,'test','test')`, [link, story]);
      const archived = await expiredEvidence();
      await database.db.query(`INSERT INTO story_merge_evidence(merged_story_id,canonical_story_id,evidence_id,role,assessment)
        VALUES($1,$2,$3,'supporting','Original assessment')`, [randomUUID(), story, archived]);
      const unrelated = await expiredItem('Unrelated expired source');
      const unrelatedEvidence = await expiredEvidence();
      let batch: string | undefined;
      if (mode === 'digest') {
        await database.db.query(`INSERT INTO operational_state(key,value) VALUES($1,$2)`,
          [`digest_refresh:${story}`, JSON.stringify({ storyId: story })]);
        await database.db.query(`INSERT INTO operational_state(key,value) VALUES('pipeline_digest','{"phase":"waiting"}')
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
      } else {
        batch = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
          VALUES('waiting',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
        await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)',
          [batch, mode === 'batch-mention' ? article.revision : recap.revision]);
      }
      const content = { headline: 'Сохраненная публикация', score: 5, details: 'Полный текст', detailsKind: 'excerpt',
        sources: [{ label: 'Recap', url: 'https://vendor.example/recap', access: 'public', primary: false, classification: 'relevant' }] };
      const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [story, JSON.stringify(content)]);
      const prepared = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status)
        VALUES($1,$2,'prepared-target','prepared') RETURNING id`, [story, snapshot]);
      const published = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status,message_id,published_at)
        VALUES($1,$2,'published-target','published',$3,now()) RETURNING id`, [story, snapshot, randomUUID()]);
      await database.db.query(`INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id)
        VALUES($1,$2,$2),($3,$2,$2)`, [prepared, story, published]);

      await cleanup(settings);
      expect((await database.db.query('SELECT id FROM source_items WHERE id=ANY($1::uuid[])', [[article.item, recap.item]])).rows).toHaveLength(2);
      expect((await database.db.query('SELECT link_id FROM story_link_sources WHERE story_id=$1', [story])).rows).toEqual([{ link_id: link }]);
      expect((await database.db.query('SELECT evidence_id FROM story_merge_evidence WHERE canonical_story_id=$1', [story])).rows).toEqual([{ evidence_id: archived }]);
      expect((await database.db.query('SELECT id FROM evidence_documents WHERE id=$1', [archived])).rows).toHaveLength(1);
      expect((await database.db.query('SELECT id FROM source_items WHERE id=$1', [unrelated.item])).rows).toHaveLength(0);
      expect((await database.db.query('SELECT id FROM evidence_documents WHERE id=$1', [unrelatedEvidence])).rows).toHaveLength(0);

      if (batch) await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1", [batch]);
      else {
        await database.db.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${story}`]);
        await database.db.query("UPDATE operational_state SET value='{\"phase\":\"completed\"}' WHERE key='pipeline_digest'");
      }
      await cleanup(settings);
      expect((await database.db.query('SELECT id FROM source_items WHERE id=ANY($1::uuid[])', [[article.item, recap.item]])).rows).toHaveLength(0);
      expect((await database.db.query('SELECT id FROM evidence_documents WHERE id=$1', [archived])).rows).toHaveLength(0);
      expect((await database.db.query('SELECT * FROM story_link_sources WHERE story_id=$1', [story])).rows).toHaveLength(0);
      expect((await database.db.query('SELECT * FROM story_merge_evidence WHERE canonical_story_id=$1', [story])).rows).toHaveLength(0);
      expect((await database.db.query('SELECT content,story_id FROM publication_snapshots WHERE id=$1', [snapshot])).rows)
        .toEqual([{ content, story_id: null }]);
      expect((await database.db.query('SELECT status,story_id,snapshot_id FROM publications WHERE id=$1', [prepared])).rows)
        .toEqual([{ status: 'prepared', story_id: null, snapshot_id: snapshot }]);
      expect((await database.db.query('SELECT status,story_id,snapshot_id FROM publications WHERE id=$1', [published])).rows)
        .toEqual([{ status: 'published', story_id: null, snapshot_id: snapshot }]);
      expect((await database.db.query('SELECT canonical_story_id FROM story_publication_aliases WHERE publication_id=ANY($1::uuid[])',
        [[prepared, published]])).rows).toEqual([{ canonical_story_id: story }, { canonical_story_id: story }]);
    });
});
