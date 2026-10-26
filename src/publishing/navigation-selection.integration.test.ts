import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import type { PublicationSnapshot } from '../types.js';

const url=process.env.TEST_DATABASE_URL;
const schema=`nav_selection_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let navigation:typeof import('./navigation.js');
let relations:typeof import('../pipeline/story-relations.js');
const body:PublicationSnapshot={headline:'Новость',details:'Исходные факты',score:8,detailsKind:'summary',sources:[]};
async function fixture(message:string,seconds:number,content=body) {
  const story=(await database.db.query<{id:string}>("INSERT INTO stories(status) VALUES('completed') RETURNING id")).rows[0]?.id;
  if (!story) throw new Error('Missing story');
  const snapshot=(await database.db.query<{id:string}>('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
    [story,JSON.stringify(content)])).rows[0]?.id;
  const id=(await database.db.query<{id:string}>(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id,status,message_id,published_at)
    VALUES($1,$2,'-100123','123','published',$3,'2026-10-25T10:00:00Z'::timestamptz+$4::int*interval '1 second') RETURNING id`,
  [story,snapshot,message,seconds])).rows[0]?.id;
  if (!id) throw new Error('Missing publication');
  return {id,story_id:story,destination_id:'-100123',bot_id:'123'};
}
async function classify(a:string,b:string,relation:'same'|'related'|'unrelated') {
  await relations.recordStoryRelations(a,[{storyId:b,relation}],'fixture',{origin:'user'});
}

describe.skipIf(!url)('verified bounded navigation selection',()=>{
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url??''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); database=await import('../db.js'); await database.migrate();
    navigation=await import('./navigation.js'); relations=await import('../pipeline/story-relations.js');
  });
  beforeEach(async()=>{await database.db.query('TRUNCATE publications,publication_snapshots,stories CASCADE');});
  afterAll(async()=>{await database?.db.end(); if(admin){await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}vi.unstubAllEnvs();});

  it('selects recent useful five after eligibility and same-component deduplication, deterministically',async()=>{
    const own=await fixture('100',100);
    const targets=[];
    for(let index=0;index<8;index++) {
      const target=await fixture(String(200+index),index);
      await classify(own.story_id,target.story_id,'related'); targets.push(target);
    }
    const edition=await fixture('300',9); const first=targets[0];
    if(!first) throw new Error('Missing target');
    await classify(first.story_id,edition.story_id,'same');
    const pending=await fixture('400',20); await classify(own.story_id,pending.story_id,'related');
    await database.db.query("UPDATE publications SET media_status='pending' WHERE id=$1",[pending.id]);
    const links=await navigation.relatedPublicationSources(database.db,own.story_id,'-100123','123');
    expect(links.map(source=>source.url)).toEqual(['300','207','206','205','204'].map(id=>`https://t.me/c/123/${id}`));
    expect(await navigation.relatedPublicationSources(database.db,own.story_id,'-100123','123')).toEqual(links);
    expect((await database.db.query("SELECT count(*)::int n FROM story_relations WHERE relation='related'")).rows[0]?.n).toBe(9);
  });
  it('does not restage unchanged related links after a JSONB round trip or replace an identical pending edit',async()=>{
    const target=await fixture('200',0); const own=await fixture('100',10);
    await classify(own.story_id,target.story_id,'related');
    const {prepareThreadUpdates}=await import('./thread-updates.js');
    const current=async()=>(await database.db.query<{snapshot_id:string;pending_snapshot_id:string|null}>(
      'SELECT snapshot_id,pending_snapshot_id FROM publications WHERE id=$1',[own.id])).rows[0];
    await prepareThreadUpdates('-100123');
    const staged=await current();
    expect(staged?.pending_snapshot_id).toBeTruthy();
    const count=(await database.db.query('SELECT count(*)::int n FROM publication_snapshots')).rows[0]?.n;
    await prepareThreadUpdates('-100123');
    expect(await current()).toEqual(staged);
    expect((await database.db.query('SELECT count(*)::int n FROM publication_snapshots')).rows[0]?.n).toBe(count);
    // Apply the stored edit receipt, then repeat maintenance against the JSONB snapshot.
    await database.db.query('UPDATE publications SET snapshot_id=pending_snapshot_id,pending_snapshot_id=NULL WHERE pending_snapshot_id IS NOT NULL');
    const sent=await current();
    for(let tick=0;tick<3;tick++) await prepareThreadUpdates('-100123');
    expect(await current()).toEqual(sent);
    expect((await database.db.query('SELECT count(*)::int n FROM publication_snapshots')).rows[0]?.n).toBe(count);
    const edition=await fixture('300',20);
    await classify(target.story_id,edition.story_id,'same');
    await prepareThreadUpdates('-100123');
    expect((await current())?.pending_snapshot_id).toBeTruthy();
  });
  it('removes a repaired related edge from display once, then leaves maintenance idle',async()=>{
    const own=await fixture('100',10); const target=await fixture('200',0);
    await classify(own.story_id,target.story_id,'related');
    const {prepareThreadUpdates}=await import('./thread-updates.js');
    const apply=async()=>database.db.query('UPDATE publications SET snapshot_id=pending_snapshot_id,pending_snapshot_id=NULL WHERE pending_snapshot_id IS NOT NULL');
    await prepareThreadUpdates('-100123'); await apply();
    await database.db.query('DELETE FROM story_relations');
    await prepareThreadUpdates('-100123');
    const desired=(await database.db.query<{content:PublicationSnapshot}>(`SELECT snap.content FROM publications p
      JOIN publication_snapshots snap ON snap.id=p.pending_snapshot_id WHERE p.id=$1`,[own.id])).rows[0]?.content;
    expect(desired?.sources).toHaveLength(1);
    expect(desired?.sources[0]).toMatchObject({unverifiedPublication:true});
    expect(desired?.sources[0]?.relatedPublication).toBeUndefined();
    const {render}=await import('./render.js');
    if(!desired) throw new Error('Missing navigation repair');
    expect(render(desired).plainText).not.toContain('Другие публикации');
    await apply();
    const count=(await database.db.query('SELECT count(*)::int n FROM publication_snapshots')).rows[0]?.n;
    for(let tick=0;tick<3;tick++) await prepareThreadUpdates('-100123');
    expect((await database.db.query('SELECT id FROM publications WHERE pending_snapshot_id IS NOT NULL')).rows).toEqual([]);
    expect((await database.db.query('SELECT count(*)::int n FROM publication_snapshots')).rows[0]?.n).toBe(count);
  });
  it('withholds old topical links and preserves every frozen link as hidden audit, leaving event text and previous links alone',async()=>{
    const target=await fixture('200',0); const previous=await fixture('90',-10);
    const related={url:'https://t.me/c/123/200',label:'Старая широкая связь',primary:false,access:'public' as const,
      classification:'relevant' as const,relatedPublication:true as const};
    const prior={...related,url:'https://t.me/c/123/90',relatedPublication:undefined,previousPublication:true as const};
    const sent={...body,sources:[related,prior]}; const own=await fixture('100',10,sent);
    await relations.recordStoryRelations(own.story_id,[{storyId:target.story_id,relation:'related'}],'grouping-v2',{origin:'model'});
    await classify(own.story_id,previous.story_id,'same');
    const desired=await navigation.desiredNavigation(database.db,own,sent);
    expect(desired.sources).toContainEqual({...related,relatedPublication:undefined,unverifiedPublication:true});
    expect(desired.sources).toContainEqual(prior);
    expect(desired).toMatchObject({headline:body.headline,details:body.details,score:body.score});
    expect(navigation.navigationOnlyChange(sent,desired)).toBe(true);
    expect(sent.sources).toContainEqual(related);
  });
});
