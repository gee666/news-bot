import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db.js';
import { publicationSnapshotSchema } from '../types.js';
import { snapshotFor, type StoryContent } from './content.js';
import { render } from './render.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `snapshot_dates_${randomUUID().replaceAll('-', '')}`;
const primaryUrl = 'https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/';
const recapUrl = 'https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-october-2026/';
let pool: pg.Pool;
let admin: pg.Pool;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await pool.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function evidence(storyId: string, publishedAt: string | null, options: {
  role?: 'primary' | 'supporting'; relevance?: 'relevant' | 'irrelevant'; verified?: boolean;
} = {}) {
  const id = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at,metadata)
    VALUES($1,'EmbeddingGemma 2','The model was released with downloadable weights.','public',
      now()-interval '1 day',$2) RETURNING id`, [primaryUrl, JSON.stringify({ status: 200, publishedAt })]);
  await pool.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at)
    VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END)`,
  [storyId, id, options.role ?? 'primary', options.relevance ?? 'relevant', options.verified ?? true]);
}
async function fixture(): Promise<StoryContent> {
  const id = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,profile_version,model_version)
    VALUES('completed','Вышла EmbeddingGemma 2','Доступны веса модели.',8,true,1,1) RETURNING id`);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('website',$1,'Google blog','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'recap',$2,'2026-11-02T12:00:00Z') RETURNING id`, [source, recapUrl]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
    VALUES($1,1,'nov-2-recap','October recap mentions EmbeddingGemma 2.','October recap mentions EmbeddingGemma 2.',$2)
    RETURNING id`, [item, JSON.stringify({ connectorKind: 'website', canonicalUrl: recapUrl, title: 'October AI recap' })]);
  await pool.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  await pool.query(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
    VALUES($1,$2,'EmbeddingGemma 2 is available',0)`, [id, revision]);
  const story = (await pool.query<StoryContent>('SELECT * FROM stories WHERE id=$1', [id])).rows[0];
  if (!story) throw new Error('Missing story');
  return story;
}

describe.skipIf(!databaseUrl)('primary publication dates frozen in snapshots', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE sources,stories,evidence_documents,publication_snapshots CASCADE');
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  it('stores Oct 6 primary alongside the Nov 2 recap and renders it after all source history is deleted', async () => {
    const story = await fixture();
    await evidence(story.id, '2026-10-06T00:00:00Z');
    const snapshot = await snapshotFor(pool, story);
    expect(snapshot.primaryPublishedAt).toBe('2026-10-06T00:00:00.000Z');
    expect(snapshot.sources.map(source => source.url)).toContain(recapUrl);
    const frozen = render(snapshot);
    expect(frozen.plainText).toContain('Дата первоисточника: 06.10.2026');
    expect(frozen.plainText).not.toContain('02.11.2026');
    const id = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
      [story.id, JSON.stringify(snapshot)]);
    await pool.query('DELETE FROM evidence_documents');
    await pool.query('DELETE FROM source_items');
    await pool.query('DELETE FROM stories');
    const row = (await pool.query<{ content: unknown }>('SELECT content FROM publication_snapshots WHERE id=$1', [id])).rows[0];
    const saved = publicationSnapshotSchema.parse(row?.content);
    expect(saved.primaryPublishedAt).toBe(snapshot.primaryPublishedAt);
    expect(render(saved)).toEqual(frozen);
  });
  it('does not manufacture a primary date from a dated recap or undated reads', async () => {
    const story = await fixture();
    await evidence(story.id, null);
    await evidence(story.id, '2026-10-06T00:00:00Z', { role: 'supporting' });
    await evidence(story.id, '2026-10-06T00:00:00Z', { relevance: 'irrelevant' });
    await evidence(story.id, '2026-10-06T00:00:00Z', { verified: false });
    const snapshot = await snapshotFor(pool, story);
    expect(snapshot).not.toHaveProperty('primaryPublishedAt');
    expect(render(snapshot).plainText).not.toContain('Дата первоисточника');
  });
  it('takes the earliest of multiple primary dates, including verified generation ancestors', async () => {
    const story = await fixture();
    const ancestor = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
    await pool.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
      VALUES($1,$2,'snapshot-test')`, [story.id, ancestor]);
    await evidence(story.id, '2026-11-02T12:00:00Z');
    await evidence(story.id, null);
    await evidence(ancestor, '2026-10-06T23:30:00-02:00');
    const snapshot = await snapshotFor(pool, story);
    expect(snapshot.primaryPublishedAt).toBe('2026-10-07T01:30:00.000Z');
    expect(render(snapshot).plainText).toContain('Дата первоисточника: 07.10.2026');
  });
});
