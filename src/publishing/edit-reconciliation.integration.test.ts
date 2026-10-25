import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationSnapshot } from '../types.js';
import { fullRepairPlan, snapshotHash, type ReviewedAction } from './approval.js';
import { renderFullText } from './full-text.js';
import { escapeHtml, type RenderedMessage } from './render.js';
import type { Publication } from './store.js';

const url=process.env.TEST_DATABASE_URL;
const schema=`editreconcile_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let store:typeof import('./store.js');
let reconcile:typeof import('./edit-reconciliation.js');
let contentFingerprint:typeof import('./reconciliation.js')['contentFingerprint'];
const body:PublicationSnapshot={headline:'Историческая новость',details:'Все исходные факты <&> 😀.',score:8,detailsKind:'summary',sources:[]};
const related={label:'Другой сюжет',url:'https://t.me/c/123/20',primary:false,access:'public' as const,
  classification:'relevant' as const,relatedPublication:true as const};
async function one(sql:string,args:unknown[]=[]):Promise<string> {
  const row=(await database.db.query<{id:string}>(sql,args)).rows[0];
  if(!row) throw new Error('Missing fixture'); return row.id;
}
async function load(id:string,edit=false):Promise<Publication> {
  const row=(await database.db.query<Publication>(`${edit?store.publicationEditSelect:store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if(!row) throw new Error('Missing publication'); return row;
}
async function fixture(content:PublicationSnapshot,album=false) {
  const storyId=await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  const priorId=await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(body)]);
  const desiredId=await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(content)]);
  const id=await one(`INSERT INTO publications(story_id,snapshot_id,pending_snapshot_id,destination_id,message_id,bot_id,status,published_at,delivery_kind,media_snapshot_id)
    VALUES($1,$2,$3,'-100123','10','123','published',now(),$4,$5) RETURNING id`,[storyId,priorId,desiredId,album?'album':'text',album?priorId:null]);
  const canonical=renderFullText(body)[0]; if(!canonical) throw new Error('Missing canonical');
  await database.db.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content,status,message_id)
    VALUES($1,0,$2,$3,'sent','10')`,[id,priorId,JSON.stringify(canonical)]);
  return {id,storyId,priorId,desiredId,canonical,publication:await load(id,true)};
}
async function unknown(id:string,snapshotId:string,message:RenderedMessage,extra:object={}) {
  return one(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata,next_retry_at)
    VALUES($1,'telegram-bot','edit',1,'unknown',$2,now()-interval '1 second') RETURNING id`,
  [id,JSON.stringify({snapshotId,fingerprint:contentFingerprint(message.plainText,message.links),...extra})]);
}
async function repairFixture() {
  const desired={...body,details:'Полные подтверждённые факты <&> 😀. '.repeat(200),sources:[related]};
  const f=await fixture(desired,true); const plan=fullRepairPlan(desired); const caption=plan[0];
  if(!caption) throw new Error('Missing caption');
  const action:ReviewedAction={approvalId:randomUUID(),operation:'edit',state:'uncertain',publicationId:f.id,
    destinationId:'-100123',messageId:'10',priorSnapshotId:f.priorId,desiredSnapshotId:f.desiredId,snapshotHash:snapshotHash(desired),
    storyId:f.storyId,contentVersion:1,receiptId:null,coordinator:'Offline reviewer',expiresAt:new Date(Date.now()-60_000).toISOString(),
    fullContentRepair:{priorSnapshotHash:snapshotHash(body),botId:'123',mediaSnapshotId:f.priorId,reason:'Restore all historical facts'}};
  await store.saveState(`publication_action:${action.approvalId}`,action);
  const attemptId=await unknown(f.id,f.desiredId,caption,{approvalId:action.approvalId,fullContentRepair:true,parts:plan});
  return {...f,plan,caption,action,attemptId};
}

describe.skipIf(!url)('unknown edit receipts in PostgreSQL',()=>{
  beforeAll(async()=>{
    admin=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,statement_timeout:15_000,lock_timeout:5000}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url??''); scoped.searchParams.set('options',`-c search_path=${schema},public -c statement_timeout=15000 -c lock_timeout=5000`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); database=await import('../db.js');
    const scope=(await database.db.query<{name:string}>('SELECT current_schema() AS name')).rows[0];
    if(scope?.name!==schema) throw new Error('Reconciliation tests require their isolated schema');
    await database.migrate();
    store=await import('./store.js'); reconcile=await import('./edit-reconciliation.js');
    contentFingerprint=(await import('./reconciliation.js')).contentFingerprint;
  },60_000);
  beforeEach(async()=>{
    vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE stories,publications,publication_snapshots,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
  });
  afterAll(async()=>{
    vi.unstubAllGlobals(); if(database) await database.db.end();
    if(admin) {await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();} vi.unstubAllEnvs();
  },30_000);
  it.each([false,true])('reconciles a pre-v2 heading and old visible audit link without rendering new presentation, album=%s',async album=>{
    const audit={...related,label:'Сохранённая ссылка',url:'https://t.me/c/123/30',relatedPublication:undefined,unverifiedPublication:true as const};
    const desired={...body,navigationVersion:1 as const,sources:[audit,related]};
    const f=await fixture(desired,album);
    let legacy=f.canonical;
    for(const [source,heading] of [[audit,'Другие публикации'],[related,'Связанные новости']] as const) {
      const prefix='\n\n'+heading+'\n';
      legacy={...legacy,text:legacy.text+`\n\n<b>${heading}</b>\n<a href="${source.url}">${escapeHtml(source.label)}</a>`,
        plainText:legacy.plainText+prefix+source.label,
        links:[...legacy.links,{offset:legacy.plainText.length+prefix.length,length:source.label.length,url:source.url}]};
    }
    const expected=contentFingerprint(legacy.plainText,legacy.links);
    const rendered=await (await import('./message-render.js')).renderPublication(f.publication);
    expect(contentFingerprint(rendered.plainText,rendered.links)).not.toBe(expected);
    await unknown(f.id,f.desiredId,legacy);
    expect(await reconcile.reconcileUnknownEdit(f.publication,async()=>expected)).toBe(true);
    expect(await load(f.id)).toMatchObject({snapshot_id:f.desiredId,pending_snapshot_id:null});
    expect((await database.db.query('SELECT content FROM publication_text_parts WHERE publication_id=$1',[f.id])).rows).toEqual([{content:legacy}]);
  });
  it('keeps a full-repair caption and its continuation plan in manual review even if the fingerprint matches',async()=>{
    const f=await repairFixture();
    const reader=vi.fn().mockResolvedValue(contentFingerprint(f.caption.plainText,f.caption.links));
    expect(await reconcile.reconcileUnknownEdit(f.publication,reader)).toBe(false);
    expect(reader).not.toHaveBeenCalled();
    expect(await load(f.id)).toMatchObject({snapshot_id:f.priorId,pending_snapshot_id:f.desiredId,message_id:'10',media_snapshot_id:f.priorId});
    expect((await database.db.query('SELECT content,status FROM publication_text_parts WHERE publication_id=$1',[f.id])).rows)
      .toEqual([{content:f.canonical,status:'sent'}]);
    expect(await store.state(`publication_action:${f.action.approvalId}`)).toMatchObject({state:'uncertain'});
    expect((await database.db.query('SELECT status,response_metadata FROM request_attempts WHERE id=$1',[f.attemptId])).rows[0])
      .toMatchObject({status:'unknown',response_metadata:{fullContentRepair:true,parts:f.plan}});
  });
});
