import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { renderFullText,withUpdateMarker } from './full-text.js';
import { renderCaption } from './caption.js';
import { escapeHtml,type RenderedMessage } from './render.js';
import { publicationSnapshotSchema,type PublicationSnapshot } from '../types.js';
import type { Publication } from './store.js';

const url=process.env.TEST_DATABASE_URL;
const schema=`navigation_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let cleanLegacyHeadings:typeof import('./message-render.js')['cleanLegacyHeadings'];
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
const auditSource={ label:'Сохранённая непроверенная ссылка',url:postUrl('30'),primary:false,
  unverifiedPublication:true as const,access:'public' as const,classification:'relevant' as const };
function appendLegacyTail(message:RenderedMessage):RenderedMessage {
  const heading='\n\nДругие публикации\n';
  return { ...message,text:message.text+'\n\n<b>Другие публикации</b>\n'+`<a href="${auditSource.url}">${escapeHtml(auditSource.label)}</a>`,
    plainText:message.plainText+heading+auditSource.label,links:[...message.links,
      { offset:message.plainText.length+heading.length,length:auditSource.label.length,url:auditSource.url }] };
}

describe.skipIf(!url)('publication navigation in PostgreSQL',()=>{
  beforeAll(async()=>{
    admin=new pg.Pool({ connectionString:url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url??''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database=await import('../db.js');
    expect((await database.db.query('SELECT current_schema() AS name')).rows[0]?.name).toBe(schema);
    await database.migrate(); cleanLegacyHeadings=(await import('./message-render.js')).cleanLegacyHeadings; store=await import('./store.js');
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
      expect(edited?.plainText).toContain(body.details+'\n\nДругие публикации\n');
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

  it.each([false,true])('hides version-1 audit navigation from frozen posts without losing source/body text, multipart=%s',async multipart=>{
    const factSource={ label:'Исходный документ <&>',url:'https://source.example/report',primary:true,
      access:'public' as const,classification:'relevant' as const };
    const snapshot:PublicationSnapshot={ ...body,details:multipart ? 'Все исходные факты <&> 😀. '.repeat(250) : body.details,
      navigationVersion:1,sources:[factSource,auditSource] };
    const a=await post('10',snapshot);
    const before=(await database.db.query<{ part_number:number; content:RenderedMessage }>(
      'SELECT part_number,content FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number',[a.id])).rows;
    const last=before.at(-1); if (!last) throw new Error('Missing frozen part');
    expect(last.part_number>0).toBe(multipart);
    await database.db.query('UPDATE publication_text_parts SET content=$3 WHERE publication_id=$1 AND part_number=$2',
      [a.id,last.part_number,JSON.stringify(appendLegacyTail(last.content))]);
    await tick(); await navigation.retryNavigationParts(api,settings,'-100123');
    const after=(await database.db.query<{ content:RenderedMessage }>(
      'SELECT content FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number',[a.id])).rows;
    expect(after.map(part=>part.content)).toEqual(before.map(part=>part.content));
    const sent=await load(a.id);
    expect(sent.content).toMatchObject({ navigationVersion:2,details:snapshot.details,sources:[factSource,auditSource] });
    expect(publicationSnapshotSchema.parse(sent.content).sources).not.toContainEqual(expect.objectContaining({ relatedPublication:true }));
    expect(vi.mocked(api.edit).mock.calls.map(call=>call[2].plainText).join('')).not.toContain('Другие публикации');
    expect(api.send).not.toHaveBeenCalled();
    const edits=vi.mocked(api.edit).mock.calls.length;
    const snapshots=(await database.db.query('SELECT id FROM publication_snapshots')).rowCount;
    await tick(); await navigation.retryNavigationParts(api,settings,'-100123');
    expect(api.edit).toHaveBeenCalledTimes(edits);
    expect((await database.db.query('SELECT id FROM publication_snapshots')).rowCount).toBe(snapshots);
  });

  it.each([false,true])('cleans old overflow navigation and keeps factual/source prefixes with related rendered once, split=%s',async split=>{
    const a=await post('10',{ ...body,navigationVersion:1,updatedTo:postUrl('20'),sources:[auditSource] }); const b=await post('20');
    await classify(a.story,b.story,'related');
    const prefix=renderFullText({ ...body,headline:'Сохранённый текст ответа',details:'Факт в старом overflow <&> 😀',sources:[{
      label:'Документ ответа',url:'https://source.example/overflow',primary:true,access:'public',classification:'relevant' }] })[0];
    if (!prefix) throw new Error('Missing overflow fixture');
    let legacy=appendLegacyTail(prefix);
    if (split) {
      const cut=10; const remaining=auditSource.label.slice(cut);
      const second={ ...prefix,text:`<a href="${auditSource.url}">${escapeHtml(remaining)}</a>`,plainText:remaining,
        links:[{ offset:0,length:remaining.length,url:auditSource.url }] };
      legacy={ ...legacy,text:legacy.text.replace(escapeHtml(auditSource.label)+'</a>',escapeHtml(auditSource.label.slice(0,cut))+'</a>'),
        plainText:legacy.plainText.slice(0,-remaining.length),links:legacy.links.map(link=>link.url===auditSource.url ? { ...link,length:cut } : link) };
      await database.db.query(`INSERT INTO publication_navigation_parts(publication_id,slot,snapshot_id,content,message_id,status)
        VALUES($1,'footer:1',$2,$3,'778','sent')`,[a.id,(await load(a.id)).snapshot_id,JSON.stringify(second)]);
    }
    await database.db.query(`INSERT INTO publication_navigation_parts(publication_id,slot,snapshot_id,content,message_id,status)
      VALUES($1,'footer:0',$2,$3,'777','sent')`,[a.id,(await load(a.id)).snapshot_id,JSON.stringify(withUpdateMarker(legacy,postUrl('20')))]);
    await tick(); await navigation.retryNavigationParts(api,settings,'-100123');
    const footer=(await database.db.query<{ content:RenderedMessage }>(
      "SELECT content FROM publication_navigation_parts WHERE publication_id=$1 AND slot='footer:0'",[a.id])).rows[0];
    expect(footer?.content).toEqual(prefix);
    const changed=vi.mocked(api.edit).mock.calls.filter(call=>['10','777','778'].includes(call[1])).map(call=>call[2]);
    expect(changed.map(part=>part.plainText).join('')).not.toContain('Связанные новости');
    expect(changed.flatMap(part=>part.links).map(link=>link.url)).not.toContain(auditSource.url);
    expect(changed.map(part=>part.plainText).join('')).not.toContain('UPD:');
    expect(changed.map(part=>part.plainText).join('').match(/Другие публикации/gu)).toHaveLength(1);
    expect(changed.flatMap(part=>part.links).filter(link=>link.url===postUrl('20'))).toHaveLength(1);
    expect(publicationSnapshotSchema.parse((await load(a.id)).content).sources).toContainEqual(auditSource);
    const stored=(await database.db.query<{ content:RenderedMessage }>(
      "SELECT content FROM publication_navigation_parts WHERE publication_id=$1 AND slot LIKE 'footer:%' ORDER BY slot",[a.id])).rows;
    expect(stored.flatMap(part=>part.content.links).map(link=>link.url)).toEqual(prefix.links.map(link=>link.url));
    expect(stored.map(part=>part.content.plainText).join('')).not.toContain('Другие публикации');
    expect(api.send).not.toHaveBeenCalled();
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
    expect(api.send).toHaveBeenCalledWith('-100123',expect.objectContaining({ plainText:expect.stringContaining('Другие публикации') }),'10');
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
    expect(original.find(part=>part.content.plainText.includes('Другие публикации'))?.part_number).toBeGreaterThan(0);
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
    expect(edited?.plainText).toContain('Другие публикации');
  });

  it('renames the old confirmed-related heading even when version-1 link metadata is unchanged',async()=>{
    const source={ label:body.headline,url:postUrl('20'),primary:false,access:'public' as const,
      classification:'relevant' as const,relatedPublication:true as const };
    const a=await post('10',{ ...body,navigationVersion:1,sources:[source] }); const b=await post('20');
    await classify(a.story,b.story,'related');
    const part=renderFullText({ ...body,sources:[source] })[0]; if (!part) throw new Error('Missing frozen text');
    const old='Связанные новости'; const current='Другие публикации';
    await database.db.query('UPDATE publication_text_parts SET content=$2 WHERE publication_id=$1',[a.id,JSON.stringify({ ...part,
      text:part.text.replace(`<b>${current}</b>`,`<b>${old}</b>`),plainText:part.plainText.replace(current,old),
      links:part.links.map(link=>({ ...link,offset:link.offset+old.length-current.length })) })]);
    await tick(); const edited=vi.mocked(api.edit).mock.calls.find(call=>call[1]==='10')?.[2];
    expect(edited?.plainText).not.toContain(old); expect(edited?.plainText.match(/Другие публикации/gu)).toHaveLength(1);
    expect(edited?.links.map(link=>link.url)).toEqual([source.url]);
  });

  it('links B only to latest complete aggregate A2, replacing it with A3 only after text and media finish',async()=>{
    const a1=await post('1276',{ ...body,headline:'A1' }); const a2=await post('1286',{ ...body,headline:'A2' });
    const b=await post('1330',{ ...body,headline:'B' });
    await classify(a1.story,a2.story,'same'); await classify(a1.story,b.story,'related'); await tick();
    const targets=async()=>publicationSnapshotSchema.parse((await load(b.id)).content).sources
      .filter(source=>source.relatedPublication).map(source=>source.url);
    expect(await targets()).toEqual([postUrl('1286')]);
    const a3=await post('1400',{ ...body,headline:'A3',details:'Полные факты A3. '.repeat(300) });
    await classify(a2.story,a3.story,'same');
    await database.db.query("UPDATE publication_text_parts SET status='prepared' WHERE publication_id=$1 AND part_number>0",[a3.id]);
    await database.db.query("UPDATE publications SET media_status='pending' WHERE id=$1",[a3.id]);
    await database.db.query('INSERT INTO publication_media_batches(publication_id,batch_number) VALUES($1,0)',[a3.id]);
    await tick(); expect(await targets()).toEqual([postUrl('1286')]);
    await database.db.query("UPDATE publication_text_parts SET status='sent' WHERE publication_id=$1",[a3.id]);
    await database.db.query("UPDATE publications SET media_status='complete' WHERE id=$1",[a3.id]);
    await tick(); expect(await targets()).toEqual([postUrl('1286')]);
    await database.db.query("UPDATE publication_media_batches SET status='sent' WHERE publication_id=$1",[a3.id]);
    await tick(); expect(await targets()).toEqual([postUrl('1400')]);
    const edited=vi.mocked(api.edit).mock.calls.filter(call=>call[1]==='1330').at(-1)?.[2];
    expect(edited?.plainText.match(/Другие публикации/gu)).toHaveLength(1);
    expect(edited?.plainText).not.toContain('Связанные новости');
    expect(edited?.links.map(link=>link.url)).toEqual([postUrl('1400')]);
    expect(publicationSnapshotSchema.parse((await load(b.id)).content).details).toBe(body.details);
  });

  it('keeps distinct related components with identical headlines, ignoring quarantined same edges and legacy threads',async()=>{
    const b=await post('10'); const c=await post('20',{ ...body,headline:'Одинаковый заголовок' });
    const d=await post('30',{ ...body,headline:'Одинаковый заголовок' });
    await classify(b.story,c.story,'related'); await classify(b.story,d.story,'related');
    await database.db.query('INSERT INTO story_publication_threads(story_id,previous_story_id) VALUES($1,$2)',[d.story,c.story]);
    const { relatedPublicationSources }=await import('./navigation.js');
    const targets=async()=>(await relatedPublicationSources(database.db,b.story,'-100123','123')).map(source=>source.url);
    expect(await targets()).toEqual([postUrl('20'),postUrl('30')]);
    await classify(c.story,d.story,'same');
    await database.db.query(`UPDATE story_relations SET provenance=provenance||'{"quarantined":true}'::jsonb
      WHERE lower_story_id=least($1::uuid,$2::uuid) AND upper_story_id=greatest($1::uuid,$2::uuid)`,[c.story,d.story]);
    await database.db.query("UPDATE story_publication_threads SET classification_version='old-verified' WHERE story_id=$1",[d.story]);
    expect(await targets()).toEqual([postUrl('20'),postUrl('30')]);
  });

  it('uses only text canonical IDs as internal targets, never historical captions or attached pictures',async()=>{
    const a=await post('10'); const legacy=await post('20',body,true); const text=await post('30');
    await classify(a.story,legacy.story,'related'); await classify(a.story,text.story,'related');
    const batch=await one("INSERT INTO publication_media_batches(publication_id,batch_number,status) VALUES($1,0,'sent') RETURNING id",[text.id]);
    await database.db.query(`INSERT INTO publication_media_items(batch_id,ordinal,type,mime_type,digest,message_id)
      VALUES($1,0,'image','image/jpeg','picture-digest','29')`,[batch]);
    const {relatedPublicationSources,textNavigationSources,latestUpdateTarget}=await import('./navigation.js');
    expect((await relatedPublicationSources(database.db,a.story,'-100123','123')).map(source=>source.url)).toEqual([postUrl('30')]);
    const links=['20','29','30'].map(id=>({...auditSource,url:postUrl(id),unverifiedPublication:undefined,previousPublication:true as const}));
    const factual={...auditSource,url:postUrl('20'),unverifiedPublication:undefined};
    expect((await textNavigationSources(database.db,[...links,factual],'-100123')).map(source=>source.url))
      .toEqual([postUrl('30'),postUrl('20')]);
    await classify(a.story,legacy.story,'same');
    expect(await latestUpdateTarget(database.db,a.id)).toBeNull();
  });

  it('formats new navigation and update markers with diamond rows and text-post headlines',async()=>{
    const a=await post('10',{...body,presentationVersion:1});
    const newest=await post('20',{...body,presentationVersion:1,headline:'Новейшие факты'});
    await classify(a.story,newest.story,'same'); await tick();
    const snapshot=publicationSnapshotSchema.parse((await load(a.id)).content);
    expect(snapshot.updatedToHeadline).toBe('Новейшие факты');
    const edited=vi.mocked(api.edit).mock.calls.find(call=>call[1]==='10')?.[2];
    expect(edited?.plainText).toContain('UPD:\n🔸 #20 · Новейшие факты');
    expect(edited?.links[0]?.url).toBe(postUrl('20'));
    await classify(a.story,newest.story,'related'); await tick();
    const related=vi.mocked(api.edit).mock.calls.filter(call=>call[1]==='10').at(-1)?.[2];
    expect(related?.plainText).not.toContain('UPD:');
    expect(related?.plainText).toContain('Другие публикации\n🔸 #20 · Новейшие факты');
    expect(related?.plainText.match(/#20 · Новейшие факты/gu)).toHaveLength(1);
  });

  it('overflows a versioned update marker without truncating a full canonical text or duplicating it on later edits',async()=>{
    const content={...body,presentationVersion:1 as const,details:'Ф'.repeat(4030)};
    const a=await post('10',content); const target=await post('20',{...body,presentationVersion:1,headline:'Новый полный заголовок события'});
    await classify(a.story,target.story,'same'); await tick();
    await navigation.retryNavigationParts(api,settings,'-100123');
    const edited=vi.mocked(api.edit).mock.calls.find(call=>call[1]==='10')?.[2];
    expect(edited?.plainText).toBe(renderFullText(content)[0]?.plainText);
    const footer=vi.mocked(api.send).mock.calls.find(call=>call[2]==='10')?.[1];
    expect(footer?.plainText).toContain('UPD:\n🔸 #20 · Новый полный заголовок события');
    expect(footer?.links.map(link=>link.url)).toEqual([postUrl('20')]);
    await classify(a.story,target.story,'related'); await tick();
    await navigation.retryNavigationParts(api,settings,'-100123');
    const changed=vi.mocked(api.edit).mock.calls.filter(call=>call[1]==='999').at(-1)?.[2];
    expect(changed?.plainText).not.toContain('UPD:');
    expect(changed?.plainText).toContain('Другие публикации\n🔸 #20 · Новый полный заголовок события');
    expect(changed?.links.map(link=>link.url)).toEqual([postUrl('20')]);
  });

  it('does not stamp or edit unrelated history just to set a navigation version',async()=>{
    await post('10'); await tick(); expect(api.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT id FROM publication_snapshots')).rows).toHaveLength(1);
  });
});
