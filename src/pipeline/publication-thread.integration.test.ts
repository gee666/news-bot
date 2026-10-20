import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import type { PublicationSnapshot } from '../types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `thread_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function story(previous?: string) {
  const id = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched)
    VALUES('completed','Тема','Новые сведения',7,true) RETURNING id`);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url)
    VALUES($1,'1',$2) RETURNING id`, [source, `https://t.me/fixture/${id}`]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Report','Report') RETURNING id`, [item, id]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal,metadata)
    VALUES($1,$2,'Report',0,$3) RETURNING id`, [id, revision, JSON.stringify(previous ? { previous_story_id: previous } : {})]);
  return { id, revision, mention };
}
async function publish(id: string, message: string, earlier?: string, destination = '-100123') {
  const content: PublicationSnapshot = { headline: `Тема ${message}`, details: `Сведения ${message}`, score: 7,
    detailsKind: 'summary', sources: [], ...(earlier ? { earlier } : {}) };
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [id, JSON.stringify(content)]);
  await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,status,message_id,published_at)
    VALUES($1,$2,$3,'published',$4::text,now()+$4::text::integer*interval '1 second')`, [id, snapshot, destination, message]);
}

describe.skipIf(!url)('published thread storage', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('rebases drafts, reads all destination-specific ancestors, and absorbs duplicate sources without changing sent text', async () => {
    const { publishedThread, latestThreadStory, rebaseFollowup, threadKnowledge, absorbIntoPublished } = await import('./publication-thread.js');
    const first = await story(); await publish(first.id, '1');
    const second = await story(first.id); await publish(second.id, '2', 'Общая предыстория');
    await publish(first.id, '8', undefined, '-100456');
    const draft = await story(first.id);
    await rebaseFollowup(draft.id);
    expect(await latestThreadStory(first.id)).toBe(first.id); // Latest publication can be in another destination.
    await database.db.query("UPDATE publications SET published_at=now()-interval '1 hour' WHERE destination_id='-100456'");
    await rebaseFollowup(draft.id);
    expect(await latestThreadStory(first.id)).toBe(second.id);
    const thread = await publishedThread(draft.id, database.db.query.bind(database.db), '-100123');
    expect(thread.map(post => post.storyId)).toEqual([first.id, second.id]);
    expect(threadKnowledge(thread)).toBe('Общая предыстория\n\nСведения 2');
    const link = await one(`INSERT INTO item_links(revision_id,url) VALUES($1,'https://author.org/original') RETURNING id`, [draft.revision]);
    await database.db.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')", [draft.mention, link]);
    await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [link, draft.id]);
    const evidence = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES('https://author.org/original','Original report','Original report details','public',now()+interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at)
      VALUES($1,$2,'primary','relevant',now())`, [draft.id, evidence]);
    const before = (await database.db.query('SELECT * FROM stories WHERE id=$1', [second.id])).rows;
    expect(await absorbIntoPublished(draft.id, second.id, ['https://author.org/original'])).toBe(true);
    expect((await database.db.query('SELECT * FROM stories WHERE id=$1', [second.id])).rows).toEqual(before);
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [draft.id])).rows).toEqual([{ status: 'rejected' }]);
    expect((await database.db.query('SELECT story_id,metadata FROM story_mentions WHERE id=$1', [draft.mention])).rows[0]).toMatchObject({
      story_id: second.id, metadata: { relation: 'same', primary_source_urls: ['https://author.org/original'] },
    });
    expect((await database.db.query("SELECT metadata ? 'previous_story_id' AS previous FROM story_mentions WHERE id=$1", [draft.mention])).rows).toEqual([{ previous: false }]);
    for (const table of ['story_evidence', 'story_link_sources']) {
      expect((await database.db.query(`SELECT story_id FROM ${table} WHERE story_id=$1`, [draft.id])).rows).toEqual([]);
      expect((await database.db.query(`SELECT story_id FROM ${table} WHERE story_id=$1`, [second.id])).rows).toHaveLength(1);
    }
    await (await import('../publishing/updates.js')).refreshPublishedSources(settings, [second.id]);
    const desired = (await database.db.query<{ content: PublicationSnapshot }>(`SELECT snap.content FROM publications p
      JOIN publication_snapshots snap ON snap.id=p.pending_snapshot_id WHERE p.story_id=$1`, [second.id])).rows[0]?.content;
    expect(desired).toMatchObject({ headline: 'Тема 2', details: 'Сведения 2', earlier: 'Общая предыстория' });
    expect(desired?.sources.some(source => source.url === 'https://author.org/original' && source.primary)).toBe(true);
    expect(await absorbIntoPublished(draft.id, second.id, [])).toBe(false);
  });
  it('keeps threads longer than twenty posts complete and stops corrupt cycles', async () => {
    const {publishedThread,latestThreadStory}=await import('./publication-thread.js');
    const ids:string[]=[];
    for (let index=0;index<22;index++) {
      const next=await story(ids.at(-1)); ids.push(next.id); await publish(next.id,String(index+20));
    }
    const last=ids.at(-1); const first=ids[0];
    if (!last || !first) throw new Error('Missing thread');
    expect((await publishedThread(last)).map(post=>post.storyId)).toEqual(ids);
    await database.db.query("UPDATE story_mentions SET metadata=jsonb_build_object('previous_story_id',$2::text) WHERE story_id=$1",[first,last]);
    expect((await publishedThread(last)).map(post=>post.storyId)).toEqual(ids);
    expect(await latestThreadStory(first)).toBe(last);
  }, 60_000);

});
