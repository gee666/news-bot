import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationSnapshot } from '../types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `pubsources_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
const content: PublicationSnapshot = { headline: 'Новая модель',details: 'Подробное описание',score: 8,detailsKind: 'summary',sources: [] };
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function contribution(storyId: string, restricted: boolean) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Recaps',$2) RETURNING id`,[randomUUID(),restricted ? 'restricted' : 'public']);
  const origin = restricted ? 'https://t.me/c/9402/10053' : 'https://t.me/recaps/10052';
  const item = await one('INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,$2,$3) RETURNING id',[source,randomUUID(),origin]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,'source-only','Все релизы с DevDay','Все релизы с DevDay') RETURNING id`,[item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,item]);
  const link = await one("INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id",[revision,`https://publisher.org/${source}`]);
  await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
    VALUES($1,$2,'relevant','fixture',1,'source-only-fixture','fixture')`,[link,storyId]);
  return origin;
}
async function snapshot(storyId: string): Promise<PublicationSnapshot> {
  const row = (await database.db.query<import('./store.js').StoryContent>('SELECT * FROM stories WHERE id=$1',[storyId])).rows[0];
  if (!row) throw new Error('Story missing'); return store.snapshotFor(database.db,row);
}

describe.skipIf(!url)('retired source-only publication contributions', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString());
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js');
  });
  beforeEach(async () => { await database.db.query('TRUNCATE stories,sources CASCADE'); });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('ignores legacy collected origins while retaining independently read relevant documents', async () => {
    const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched)
      VALUES('completed',$1,$2,8,true) RETURNING id`,[content.headline,content.details]);
    const origins = [await contribution(storyId,false), await contribution(storyId,true)];
    const target = 'https://publisher.org/read-event-recap';
    const doc = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES($1,'Read event recap','Actual event recap text','public',now()+interval '1 day') RETURNING id`,[target]);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[storyId,doc]);
    const desired = await snapshot(storyId);
    expect(desired.sources.map(source => source.url)).toEqual([target]);
    expect(desired.sources.some(source => origins.includes(source.url))).toBe(false);
    expect((await database.db.query('SELECT id FROM story_mentions')).rows).toHaveLength(0);
  });
  it('does not resurrect legacy links or origins and preserves frozen historical snapshots', async () => {
    const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched)
      VALUES('completed',$1,$2,8,true) RETURNING id`,[content.headline,content.details]);
    const origin = await contribution(storyId,false);
    const archived: PublicationSnapshot = { ...content,sources: [
      { label: 'Архивная публикация',url: origin,primary: false,access: 'public',classification: 'relevant' },
    ] };
    const id = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(archived)]);
    expect((await snapshot(storyId)).sources).toEqual([]);
    const preserved = (await database.db.query<{ content: unknown }>('SELECT content FROM publication_snapshots WHERE id=$1',[id])).rows[0]?.content;
    expect(preserved).toEqual(archived);
  });
});
