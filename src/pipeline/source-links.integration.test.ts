import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JevAnswer } from '../models/jev.js';
import type { AppSettings } from '../settings.js';
import type { SourceConfirmationInput } from './source-links-confirmation.js';
vi.mock('./source-links-confirmation.js', async original => ({ ...await original<typeof import('./source-links-confirmation.js')>(),
  SOURCE_CONFIRMATION_VERSION: 'source-link-confirmation-v1',
  confirmSourceLinks: async (input: SourceConfirmationInput) => input.candidates.map(candidate => ({
    candidate_id: candidate.candidate_id, verdict: 'relevant', reason: 'Fixture supplied same-event context',
    source_quote: input.message, story_quote: candidate.story,
  })),
}));
const url = process.env.TEST_DATABASE_URL;
const schema = `source_links_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let origin: string;
let revision: string;
let story: string;
let sibling: string;
let unrelated: string;
let sourceId: string;
const recap = 'Все релизы с DevDay: https://openai.com/ru-RU/index/devday-2026-recap/';
async function one(sql: string, args: unknown[] = []) {
  const result = await database.db.query<{id:string}>(sql,args);
  const id=result.rows[0]?.id;if(!id)throw new Error('Missing fixture id');return id;
}
async function item(text:string,externalId:string) {
  const id=await one('INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,$2,$3) RETURNING id',
    [sourceId,externalId,`https://t.me/test/${externalId}`]);
  const rev=await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$2,$2) RETURNING id`,[id,text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1',[id,rev]);
  return {id,rev};
}
describe.skipIf(!url)('source-only association database contract',()=>{
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url ?? '');scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString());
    // Settings imports db.ts, so load all application modules only after scoping DATABASE_URL.
    database=await import('../db.js');
    expect((await database.db.query('SELECT current_schema() AS name')).rows[0]?.name).toBe(schema);
    await database.migrate();
    expect((await database.db.query("SELECT table_schema FROM information_schema.tables WHERE table_name='sources' AND table_schema=$1",[schema])).rows)
      .toEqual([{table_schema:schema}]);
    settings={...(await import('../settings.js')).defaultSettings,jevUrl:'http://localhost:8765'};
    sourceId=await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram','source-only','Data Secrets','public') RETURNING id");
    const source=await item(recap,'10052');origin=source.id;revision=source.rev;
    await database.db.query('INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,$3)',
      [revision,'https://openai.com/ru-RU/index/devday-2026-recap/','Все релизы']);
    const ids=[];
    for(const [index,text] of ['OpenAI DevDay GPT-6 Cyber preview','OpenAI DevDay Decisions API release','Anthropic Sonnet 5.5 release'].entries()) {
      const mention=await item(text,String(index));
      const id=await one("INSERT INTO stories(status,chosen_excerpt,interest_score) VALUES('completed',$1,5) RETURNING id",[text]);
      await database.db.query('INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,$3,0)',[mention.rev,id,text]);
      ids.push(id);
    }
    [story='',sibling='',unrelated='']=ids;
    const ad=await item('Приходите на платный вебинар, зарегистрируйтесь на курс','10033');
    await database.db.query("INSERT INTO item_links(revision_id,url) VALUES($1,'https://example.org/course')",[ad.rev]);
  });
  afterAll(async()=>{
    if(database)await database.db.end();
    if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
    vi.unstubAllEnvs();
  });
  it('adds recap links to two existing events, excludes ads/unrelated events, reruns idempotently',async()=>{
    const {associateSourceLinks}=await import('./source-links.js');
    const judge=vi.fn(async(template:string,state:unknown):Promise<JevAnswer>=>{
      const text=JSON.stringify(state);
      const choice=template==='source_link_role'?(text.includes('платный')?'excluded':'source_only')
        :(text.includes('Anthropic')?'irrelevant':'relevant');
      return {type:'choice',choice,probabilities:{[choice]:1},confidence:1};
    });
    const result=await associateSourceLinks(settings,{judgments:{judge}});
    expect(result.associated).toBe(2);
    expect((await database.db.query("SELECT story_id FROM story_link_sources WHERE classification='relevant' ORDER BY story_id")).rows)
      .toEqual([story,sibling].sort().map(story_id=>({story_id})));
    expect((await database.db.query('SELECT classification FROM story_link_sources WHERE story_id=$1',[unrelated])).rows)
      .toEqual([{classification:'irrelevant'}]);
    expect((await database.db.query('SELECT count(*)::int AS n FROM stories')).rows[0]?.n).toBe(3);
    expect((await database.db.query('SELECT count(*)::int AS n FROM story_mentions WHERE revision_id=$1',[revision])).rows[0]?.n).toBe(0);
    expect((await associateSourceLinks(settings,{judgments:{judge}})).associated).toBe(0);
    const {loadStory}=await import('./generation-store.js');
    expect((await loadStory(story)).links).toEqual([expect.objectContaining({url:'https://openai.com/ru-RU/index/devday-2026-recap/',
      original_url:'https://t.me/test/10052',source_name:'Data Secrets',classification:'relevant',access:'public'})]);
    expect((await loadStory(unrelated)).links).toEqual([]);
  });
  it('keeps full link inventory and excludes noncurrent source revisions',async()=>{
    const {loadStory}=await import('./generation-store.js');
    await database.db.query(`INSERT INTO item_links(revision_id,url)
      SELECT $1,'https://example.org/'||n FROM generate_series(1,101) AS n`,[revision]);
    await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      SELECT id,$2,'relevant','test',1,'test','test' FROM item_links WHERE revision_id=$1 ON CONFLICT DO NOTHING`,[revision,story]);
    expect((await loadStory(story)).links).toHaveLength(102);
    const next=await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,'edited','Edited','Edited') RETURNING id`,[origin]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1',[origin,next]);
    expect((await loadStory(story)).links).toEqual([]);
  });
  it('drains 51+ source messages across bounded calls and does no repeat work once current',async()=>{
    const {associateSourceLinks}=await import('./source-links.js');
    const last=await item(recap,'queue-recap');
    await database.db.query("INSERT INTO item_links(revision_id,url) VALUES($1,'https://openai.com/recap')",[last.rev]);
    for(let n=0;n<51;n++) {
      const ad=await item('Платный курс, регистрация '+n,'queue-ad-'+n);
      await database.db.query('INSERT INTO item_links(revision_id,url) VALUES($1,$2)',[ad.rev,'https://example.org/course/'+n]);
    }
    const judge=vi.fn(async(template:string,state:unknown):Promise<JevAnswer>=>{
      const choice=template==='source_link_role'?(JSON.stringify(state).includes('DevDay')?'source_only':'excluded'):'relevant';
      return {type:'choice',choice,probabilities:{[choice]:1},confidence:1};
    });
    const first=await associateSourceLinks(settings,{judgments:{judge}});
    expect(first.messages).toBe(50);
    const second=await associateSourceLinks(settings,{judgments:{judge}});
    expect(second.messages).toBeGreaterThan(0);
    expect(second.messages).toBeLessThanOrEqual(50);
    const calls=judge.mock.calls.length;
    expect((await associateSourceLinks(settings,{judgments:{judge}})).messages).toBe(0);
    expect(judge).toHaveBeenCalledTimes(calls);
    expect((await database.db.query(`SELECT count(*)::int AS n FROM source_link_processing p
      JOIN item_revisions r ON r.id=p.revision_id JOIN source_items i ON i.current_revision_id=r.id
      WHERE i.external_id LIKE 'queue-%'`)).rows[0]?.n).toBe(52);
    // This current association must be reconsidered even if lexical retrieval can only return one other story.
    await database.db.query("UPDATE story_mentions SET text='An unrelated corrected story' WHERE story_id=$1",[story]);
    judge.mockClear();
    await associateSourceLinks({...settings,matchCandidateLimit:1},{judgments:{judge},limits:{maxMessages:100}});
    expect(judge.mock.calls.some(([template,state])=>template==='link_relevance'
      && JSON.stringify(state).includes('An unrelated corrected story'))).toBe(true);
  });
  it('rejudges v2 processing stamps and replaces an old wrong relevant Cloud association',async()=>{
    const {associateSourceLinks}=await import('./source-links.js');
    const {pendingSourceMessages,completeSourceMessage}=await import('./source-links-queue.js');
    const message=await item('Yandex Cloud выложил продуктовый дайджест. В локальном контуре можно развернуть Stackland.','11522');
    const link=await one("INSERT INTO item_links(revision_id,url) VALUES($1,'https://yandex.cloud/ru/blog/digest-scale-2026') RETURNING id",[message.rev]);
    await database.db.query("UPDATE story_mentions SET text='Codex Cloud сохраняет сессию при закрытии ноутбука' WHERE story_id=$1",[story]);
    await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','old',1,'source-link-role-v1:link-relevance-v2','old')`,[link,story]);
    const limits={maxMessages:100};
    for(const pending of await pendingSourceMessages(settings,'source-link-role-v1:link-relevance-v2',limits)) {
      await completeSourceMessage(pending,'source_only');
    }
    expect(await pendingSourceMessages(settings,'source-link-role-v1:link-relevance-v2',limits)).toEqual([]);
    await database.db.query('UPDATE stories SET interest_stale=false WHERE id=$1',[story]);
    const judge=vi.fn(async(template:string,state:unknown):Promise<JevAnswer>=>{
      const choice=template==='source_link_role'?(JSON.stringify(state).includes('Yandex')?'source_only':'excluded'):'irrelevant';
      return {type:'choice',choice,probabilities:{[choice]:1},confidence:1};
    });
    await associateSourceLinks(settings,{judgments:{judge},limits});
    expect((await database.db.query('SELECT classification,prompt_version FROM story_link_sources WHERE link_id=$1 AND story_id=$2',[link,story])).rows)
      .toEqual([{classification:'irrelevant',prompt_version:'source-link-role-v1:link-relevance-v3:source-link-confirmation-v1'}]);
    expect((await database.db.query('SELECT interest_stale FROM stories WHERE id=$1',[story])).rows[0]?.interest_stale).toBe(true);
    expect(judge.mock.calls.some(([template,state])=>template==='link_relevance' && JSON.stringify(state).includes('Codex Cloud'))).toBe(true);
    const {loadStory}=await import('./generation-store.js');
    expect((await loadStory(story)).links.some(source=>source.url==='https://yandex.cloud/ru/blog/digest-scale-2026')).toBe(false);
  });
});
