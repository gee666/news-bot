import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { renderFullText } from './full-text.js';
import { renderCaption } from './caption.js';
import { cleanLegacyHeadings } from './message-render.js';
import type { PublicationSnapshot } from '../types.js';
import type { Publication } from './store.js';

const url=process.env.TEST_DATABASE_URL;
const schema=`navigation_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let store:typeof import('./store.js');
let threads:typeof import('./thread-updates.js');
let updates:typeof import('./updates.js');
let navigation:typeof import('./navigation-delivery.js');
let relations:typeof import('../pipeline/story-relations.js');
let settings:import('../settings.js').AppSettings;
let api:BotApi;
const body:PublicationSnapshot={ headline:'Исходная новость',details:'Все исходные факты <&> 😀',score:8,detailsKind:'summary',sources:[] };
const postUrl=(id:string)=>`https://t.me/c/123/${id}`;
async function one(sql:string,values:unknown[]=[]):Promise<string> {
  const row=(await database.db.query<{ id:string }>(sql,values)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function load(id:string):Promise<Publication> {
  const row=(await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!row) throw new Error('Missing publication'); return row;
}
async function post(messageId:string,content:PublicationSnapshot=body,album=false) {
  const story=await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  const snapshot=await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[story,JSON.stringify(content)]);
  const id=await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id,status,message_id,published_at,delivery_kind)
    VALUES($1,$2,'-100123','123','published',$3,now()+$4::int*interval '1 second',$5) RETURNING id`,
  [story,snapshot,messageId,Number(messageId),album?'album':'text']);
  if (!album) for (const [index,part] of renderFullText(content).entries()) await database.db.query(`INSERT INTO publication_text_parts
    (publication_id,part_number,snapshot_id,content,status,message_id) VALUES($1,$2,$3,$4,'sent',$5)`,
  [id,index,snapshot,JSON.stringify(part),String(Number(messageId)+index)]);
  return { id,story };
}
async function classify(a:string,b:string,relation:'same'|'related'|'unrelated') {
  await relations.recordStoryRelations(a,[{ storyId:b,relation }],'user-fixture',{ origin:'user' });
}
async function tick() { await threads.prepareThreadUpdates('-100123'); await updates.retryEdits(api,settings,'-100123'); }

describe.skipIf(!url)('publication navigation in PostgreSQL',()=>{
  beforeAll(async()=>{
    admin=new pg.Pool({ connectionString:url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url??''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database=await import('../db.js'); await database.migrate(); store=await import('./store.js');
    threads=await import('./thread-updates.js'); updates=await import('./updates.js');
    navigation=await import('./navigation-delivery.js'); relations=await import('../pipeline/story-relations.js');
  });
  beforeEach(async()=>{
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings=await (await import('../settings.js')).saveSettings({ publishingEnabled:true });
    await store.saveState('telegram_destination',{ channelId:'-100123' });
    api=new BotApi('123:synthetic'); vi.spyOn(api,'identity').mockResolvedValue({ id:123,is_bot:true });
    vi.spyOn(api,'edit').mockResolvedValue(undefined); vi.spyOn(api,'editCaption').mockResolvedValue(undefined);
    vi.spyOn(api,'send').mockResolvedValue('999');
  });
  afterAll(async()=>{
    vi.unstubAllGlobals(); vi.restoreAllMocks(); if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('adds bidirectional related links at the bottom without changing facts or implying UPD',async()=>{
    const a=await post('10'); const b=await post('20',{ ...body,headline:'Отдельное событие' });
    await classify(a.story,b.story,'related'); await tick();
    for (const [current,target] of [[a,'20'],[b,'10']] as const) {
      const sent=await load(current.id);
      expect(sent.content).toMatchObject({ details:body.details,score:8 });
      expect(sent.content).not.toHaveProperty('updatedTo');
      expect(sent.content).toMatchObject({ sources:[{ relatedPublication:true,url:postUrl(target) }] });
      const edited=vi.mocked(api.edit).mock.calls.find(call=>call[1]===sent.message_id)?.[2];
      expect(edited?.plainText).toContain(body.details+'\n\nСвязанные новости\n');
      expect(edited?.links.at(-1)?.url).toBe(postUrl(target));
    }
    const count=vi.mocked(api.edit).mock.calls.length; await tick();
    expect(api.edit).toHaveBeenCalledTimes(count); expect(api.send).not.toHaveBeenCalled();
  });

  it('removes false markers and reclassifies previous links after same becomes related',async()=>{
    const a=await post('10');
    const previous={ label:body.headline,url:postUrl('10'),primary:false,previousPublication:true as const,
      access:'public' as const,classification:'relevant' as const };
    const b=await post('20',{ ...body,sources:[previous] });
    await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
      VALUES($1,$2,'grouping-v2')`,[b.story,a.story]);
    await classify(a.story,b.story,'same'); await tick();
    expect((await load(a.id)).content).toMatchObject({ updatedTo:postUrl('20') });
    await classify(a.story,b.story,'related'); await tick();
    for (const current of [a,b]) expect((await load(current.id)).content).not.toHaveProperty('updatedTo');
    expect((await load(b.id)).content).toMatchObject({ sources:[{ relatedPublication:true,url:postUrl('10') }] });
    expect((await load(b.id)).content).toMatchObject({ details:body.details });
    expect(vi.mocked(api.edit).mock.calls.filter(call=>call[1]==='10').at(-1)?.[2].plainText).not.toContain('UPD:');
  });

  it('unverified legacy ancestry cannot authorize UPD or discard its old link',async()=>{
    const a=await post('10',{ ...body,updatedTo:postUrl('20') });
    const b=await post('20',{ ...body,sources:[{ label:'Legacy link',url:postUrl('10'),primary:false,
      previousPublication:true,access:'public',classification:'relevant' }] });
    await database.db.query('INSERT INTO story_publication_threads(story_id,previous_story_id) VALUES($1,$2)',[b.story,a.story]);
    await tick(); expect((await load(a.id)).content).not.toHaveProperty('updatedTo');
    expect((await load(b.id)).content).toMatchObject({ sources:[{ unverifiedPublication:true,url:postUrl('10') }] });
    expect((await load(b.id)).content).toMatchObject({ details:body.details });
  });

  it('cleans formatted legacy headings and keeps literal unformatted paragraph text',async()=>{
    const snapshot={ ...body,earlier:'Все прежние факты',details:'Новое\nБуквальный текст\n\nРанее было опубликовано\nЦитата' };
    const a=await post('10',snapshot);
    const rendered=renderFullText(snapshot)[0]; if (!rendered) throw new Error('Missing text');
    const html=rendered.text.replace(body.headline+'</b>\n\n',body.headline+'</b>\n\n<b>Новое</b>\n')
      .replace('\n\nВсе прежние факты','\n\n<b>Ранее было опубликовано</b>\nВсе прежние факты');
    const legacy={ ...rendered,text:html,plainText:rendered.plainText.replace(body.headline+'\n\n',body.headline+'\n\nНовое\n')
      .replace('\n\nВсе прежние факты','\n\nРанее было опубликовано\nВсе прежние факты') };
    expect(cleanLegacyHeadings(rendered)).toEqual(rendered);
    await database.db.query('UPDATE publication_text_parts SET content=$2 WHERE publication_id=$1',[a.id,JSON.stringify(legacy)]);
    await tick(); const edited=vi.mocked(api.edit).mock.calls[0]?.[2];
    expect(edited?.plainText).toBe(rendered.plainText); expect(edited?.text).toBe(rendered.text);
    expect((await load(a.id)).content).toMatchObject(snapshot);
  });

  it('keeps a full caption intact and persists only necessary overflow with safe 429/unknown delivery',async()=>{
    const a=await post('10',{ ...body,details:'Длинный исходный текст. '.repeat(300) },true);
    const b=await post('20'); await classify(a.story,b.story,'related');
    const original=renderCaption((await load(a.id)).content); await tick();
    expect(vi.mocked(api.editCaption).mock.calls[0]?.[2]).toEqual(original);
    vi.mocked(api.send).mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000));
    await navigation.retryNavigationParts(api,settings,'-100123'); expect(await store.rateLimited()).toBe(true);
    await navigation.retryNavigationParts(api,settings,'-100123'); expect(api.send).toHaveBeenCalledTimes(1);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_navigation_parts SET next_retry_at=now()-interval '1 second'");
    vi.mocked(api.send).mockRejectedValueOnce(new BotError('telegram_transport_unknown','unknown'));
    await navigation.retryNavigationParts(api,settings,'-100123'); await navigation.recoverNavigationParts('-100123');
    await navigation.retryNavigationParts(api,settings,'-100123'); expect(api.send).toHaveBeenCalledTimes(2);
    const remove=vi.spyOn(api,'delete').mockResolvedValue(undefined);
    const { deletePublicationMessages }=await import('./media-delivery.js');
    await expect(deletePublicationMessages(await load(a.id),api)).rejects.toMatchObject({ code:'publication_navigation_requires_review' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes confirmed overflow before the original post, without deleting twice',async()=>{
    const a=await post('10',{ ...body,details:'Длинный исходный текст. '.repeat(300) },true);
    const b=await post('20'); await classify(a.story,b.story,'related'); await tick();
    await navigation.retryNavigationParts(api,settings,'-100123');
    expect(api.send).toHaveBeenCalledWith('-100123',expect.objectContaining({ plainText:expect.stringContaining('Связанные новости') }),'10');
    const remove=vi.spyOn(api,'delete').mockResolvedValue(undefined);
    const { deletePublicationMessages }=await import('./media-delivery.js');
    await deletePublicationMessages(await load(a.id),api);
    expect(remove.mock.calls.map(call=>call[1])).toEqual(['999','10']);
  });

  it('removes generated related links from later text parts when reclassified unrelated',async()=>{
    const b=await post('20');
    const a=await post('10',{ ...body,details:'Полные исходные факты. '.repeat(300),sources:[{
      label:'Отдельная новость',url:postUrl('20'),primary:false,relatedPublication:true,
      access:'public',classification:'relevant' }] });
    await classify(a.story,b.story,'related');
    const original=(await database.db.query<{ part_number:number; content:{ plainText:string } }>(
      'SELECT part_number,content FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number',[a.id])).rows;
    expect(original.find(part=>part.content.plainText.includes('Связанные новости'))?.part_number).toBeGreaterThan(0);
    await classify(a.story,b.story,'unrelated'); await tick();
    await navigation.retryNavigationParts(api,settings,'-100123');
    const changed=(await database.db.query<{ content:{ plainText:string; links:{url:string}[] } }>(
      'SELECT content FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number',[a.id])).rows;
    expect(changed.flatMap(part=>part.content.links).map(link=>link.url)).not.toContain(postUrl('20'));
    expect(changed.map(part=>part.content.plainText).join('')).toContain('Полные исходные факты. '.repeat(300));
    expect((await load(a.id)).content).toMatchObject({ sources:[] });
    expect(api.send).not.toHaveBeenCalled();
  });

  it('never strips an absent UPD prefix from a full caption after marker overflow and later edits',async()=>{
    const a=await post('10',{ ...body,details:'Исходный длинный текст. '.repeat(300) },true);
    const b=await post('20'); await classify(a.story,b.story,'same'); await tick();
    const baseline=vi.mocked(api.editCaption).mock.calls[0]?.[2];
    expect(baseline?.plainText).toContain('Исходный длинный текст.');
    expect(baseline?.plainText).not.toContain('UPD:');
    const frozen=(await database.db.query<{ content:unknown }>('SELECT content FROM publication_text_parts WHERE publication_id=$1',[a.id])).rows[0];
    expect(frozen?.content).toEqual(baseline);
    await classify(a.story,b.story,'related'); await tick();
    expect(vi.mocked(api.editCaption).mock.calls.at(-1)?.[2]).toEqual(baseline);
  });

  it('preserves legacy caption source labels when related links need additional space',async()=>{
    const sources=Array.from({length:3},(_,index)=>({ label:'Исходный источник '+index,url:'https://source.example/'+index,
      primary:false,access:'public' as const,classification:'relevant' as const }));
    const a=await post('10',{ ...body,sources }); const b=await post('20');
    await database.db.query("UPDATE publications SET delivery_kind='album' WHERE id=$1",[a.id]);
    await database.db.query('DELETE FROM publication_text_parts WHERE publication_id=$1',[a.id]);
    await classify(a.story,b.story,'related'); await tick();
    const edited=vi.mocked(api.editCaption).mock.calls[0]?.[2];
    expect(edited?.links.map(link=>link.url)).toEqual([...sources.map(source=>source.url),postUrl('20')]);
    for (const source of sources) expect(edited?.plainText).toContain(source.label);
    expect(edited?.plainText).toContain('Связанные новости');
  });

  it('does not stamp or edit unrelated history just to set a navigation version',async()=>{
    await post('10'); await tick(); expect(api.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT id FROM publication_snapshots')).rows).toHaveLength(1);
  });
});
