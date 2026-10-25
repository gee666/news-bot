import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import { renderCanonicalText } from './canonical-text.js';
import type { PublicationSnapshot } from '../types.js';
import type { Publication } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `no_replies_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let store:typeof import('./store.js');
let threads:typeof import('./thread-updates.js');
let updates:typeof import('./updates.js');
let navigation:typeof import('./navigation-delivery.js');
let relations:typeof import('../pipeline/story-relations.js');
let settings:import('../settings.js').AppSettings;
let api:BotApi;
const body:PublicationSnapshot = { headline:'Событие',details:'Все исходные факты <&> 😀',score:8,detailsKind:'summary',presentationVersion:1,sources:[] };
async function one(sql:string, values:unknown[] = []):Promise<string> {
  const row = (await database.db.query<{ id:string }>(sql,values)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function load(id:string):Promise<Publication> {
  const row = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!row) throw new Error('Missing publication'); return row;
}
async function post(message:string,content = body,kind:Publication['delivery_kind'] = 'media_first') {
  const story = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[story,JSON.stringify(content)]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id,status,message_id,published_at,delivery_kind)
    VALUES($1,$2,'-100123','123','published',$3,now()+$4::int*interval '1 second',$5) RETURNING id`,[story,snapshot,message,Number(message),kind]);
  const rendered = renderCanonicalText(content,kind === 'album' ? 1024 : 4096);
  await database.db.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content,status,message_id)
    VALUES($1,0,$2,$3,'sent',$4)`,[id,snapshot,JSON.stringify(rendered),message]);
  return { id,story,snapshot,rendered };
}
async function classify(a:string,b:string,relation:'same'|'related') {
  await relations.recordStoryRelations(a,[{ storyId:b,relation }],'user-fixture',{ origin:'user' });
}
async function tick() {
  await threads.prepareThreadUpdates('-100123');
  await updates.retryEdits(api,settings,'-100123');
  await navigation.retryNavigationParts(api,settings,'-100123');
}

describe.skipIf(!url)('no-replies publishing policy in PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString:url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js');
    expect((await database.db.query('SELECT current_schema() AS name')).rows[0]?.name).toBe(schema);
    await database.migrate(); store = await import('./store.js'); threads = await import('./thread-updates.js');
    updates = await import('./updates.js'); navigation = await import('./navigation-delivery.js');
    relations = await import('../pipeline/story-relations.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled:true });
    await store.saveState('telegram_destination',{ channelId:'-100123' });
    api = new BotApi('123:synthetic'); vi.spyOn(api,'identity').mockResolvedValue({ id:123,is_bot:true });
    vi.spyOn(api,'edit').mockResolvedValue(undefined); vi.spyOn(api,'editCaption').mockResolvedValue(undefined);
    vi.spyOn(api,'send').mockRejectedValue(new Error('Separate messages forbidden'));
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('puts links to 1624 and 1663 directly in the canonical text, without footer rows or sends', async () => {
    const a = await post('1615'); const b = await post('1624'); const c = await post('1663');
    await classify(a.story,b.story,'related'); await classify(a.story,c.story,'related'); await tick();
    const edited = vi.mocked(api.edit).mock.calls.find(call => call[1] === '1615')?.[2];
    expect(edited?.plainText).toContain(body.details);
    expect(edited?.links.map(link => link.url).sort()).toEqual(['https://t.me/c/123/1624','https://t.me/c/123/1663']);
    expect((await database.db.query('SELECT * FROM publication_navigation_parts')).rows).toHaveLength(0);
    expect(api.send).not.toHaveBeenCalled();
  });
  it.each(['album','media_first'] as const)('leaves a full %s unchanged instead of creating related-link overflow', async kind => {
    const limit = kind === 'album' ? 1024 : 4096;
    const overhead = renderCanonicalText({ ...body,details:'x' }).plainText.length-1;
    const a = await post('1615',{ ...body,details:'x'.repeat(limit-overhead) },kind); const b = await post('1663');
    await classify(a.story,b.story,'related'); await tick(); await tick();
    expect(await load(a.id)).toMatchObject({ snapshot_id:a.snapshot,pending_snapshot_id:null,error_code:'publication_navigation_requires_new_edition' });
    expect(vi.mocked(api.edit).mock.calls.some(call => call[1] === '1615')).toBe(false);
    expect(api.editCaption).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT * FROM publication_navigation_parts WHERE publication_id=$1',[a.id])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT content FROM publication_text_parts WHERE publication_id=$1',[a.id])).rows[0]?.content).toEqual(a.rendered);
  });
  it.each(['prepared','retryable','unknown'] as const)('does not resume an old %s footer:0 after recovery', async status => {
    const a = await post('1615');
    await database.db.query(`INSERT INTO publication_navigation_parts(publication_id,slot,snapshot_id,content,status)
      VALUES($1,'footer:0',$2,$3,$4)`,[a.id,a.snapshot,JSON.stringify(a.rendered),status]);
    await navigation.recoverNavigationParts('-100123'); await navigation.retryNavigationParts(api,settings,'-100123');
    expect(api.send).not.toHaveBeenCalled(); expect(api.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status,message_id FROM publication_navigation_parts WHERE publication_id=$1',[a.id])).rows)
      .toEqual([{ status,message_id:null }]);
  });
  it('keeps already sent footer 1664 untouched and blocks a staged edit adding more separate links', async () => {
    const a = await post('1615');
    await database.db.query(`INSERT INTO publication_navigation_parts(publication_id,slot,snapshot_id,content,status,message_id)
      VALUES($1,'footer:0',$2,$3,'prepared','1664')`,[a.id,a.snapshot,JSON.stringify(a.rendered)]);
    await navigation.retryNavigationParts(api,settings,'-100123');
    expect(api.edit).not.toHaveBeenCalled(); expect(api.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT message_id FROM publication_navigation_parts WHERE publication_id=$1',[a.id])).rows).toEqual([{ message_id:'1664' }]);
  });
});
