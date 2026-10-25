import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { renderCaption } from './caption.js';
import { renderFullText } from './full-text.js';
import type { PublicationSnapshot } from '../types.js';
import type { ReviewedAction } from './approval.js';
import type { Publication } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `fullrepair_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let store:typeof import('./store.js');
let approval:typeof import('./approval.js');
let repair:typeof import('./full-repair.js');
let settings:import('../settings.js').AppSettings;
type RepairAction = Extract<ReviewedAction,{operation:'edit'}>;
const sources:PublicationSnapshot['sources'] = [
  ...Array.from({length:5},(_,index) => ({label:`Origin ${index+1}`,url:`https://origin${index+1}.example/report`,
    primary:index===0,access:'public' as const,classification:'relevant' as const})),
  {label:'Prior edition',url:'https://t.me/channel/1276',primary:false,access:'public',classification:'relevant',previousPublication:true},
  {label:'Related story',url:'https://t.me/channel/1330',primary:false,access:'public',classification:'relevant',relatedPublication:true},
];
async function one(sql:string,values:unknown[]=[]):Promise<string> {
  const value = (await database.db.query<{id:string}>(sql,values)).rows[0];
  if (!value) throw new Error('Missing fixture'); return value.id;
}
async function row(id:string):Promise<Publication> {
  const value = (await database.db.query<Publication>(`${store.publicationEditSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!value) throw new Error('Missing publication'); return value;
}
async function save(action:RepairAction) { await store.saveState(approval.actionKey(action.approvalId),action); }
async function fixture(details='Reviewed full account, including the two-month coordination and all earlier facts.') {
  // Deliberately no model-generation receipt. Only this exact reviewed migration may run.
  const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','Historical event',$1,8,true,false,$2,$3) RETURNING id`,[details,settings.profileVersion,settings.modelVersion]);
  const previous:PublicationSnapshot = {headline:'Historical event',details:'Old shortened summary',earlier:'Earlier fact. '.repeat(25),
    detailsKind:'summary',score:8,sources};
  const desired:PublicationSnapshot = {...previous,details};
  const priorSnapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(previous)]);
  const desiredSnapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(desired)]);
  const publicationId = await one(`INSERT INTO publications(story_id,snapshot_id,pending_snapshot_id,destination_id,status,message_id,bot_id,
    delivery_kind,media_status,media_snapshot_id) VALUES($1,$2,$3,'-100123','published','1286','123','album','complete',$2) RETURNING id`,
  [storyId,priorSnapshotId,desiredSnapshotId]);
  await database.db.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content,status,message_id)
    VALUES($1,0,$2,$3,'sent','1286')`,[publicationId,priorSnapshotId,JSON.stringify(renderCaption(previous))]);
  const batchId = await one("INSERT INTO publication_media_batches(publication_id,batch_number,status) VALUES($1,0,'sent') RETURNING id",[publicationId]);
  await database.db.query(`INSERT INTO publication_media_items(batch_id,ordinal,type,mime_type,digest,message_id)
    VALUES($1,0,'image','image/png','original-unchanged-digest','1286')`,[batchId]);
  const action:RepairAction = {approvalId:randomUUID(),state:'approved',operation:'edit',publicationId,destinationId:'-100123',messageId:'1286',
    priorSnapshotId,desiredSnapshotId,snapshotHash:approval.snapshotHash(desired),storyId,contentVersion:1,receiptId:null,
    expiresAt:new Date(Date.now()+60_000).toISOString(),coordinator:'operator and independent reviewer',
    fullContentRepair:{priorSnapshotHash:approval.snapshotHash(previous),botId:'123',mediaSnapshotId:priorSnapshotId,
      reason:'Explicitly reviewed restoration of the complete legacy media publication'}};
  await save(action);
  return {action,desired,previous};
}
async function textParts(id:string) {
  return (await database.db.query<{content:import('./render.js').RenderedMessage;snapshot_id:string;status:string;message_id:string}>(
    'SELECT * FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number',[id])).rows;
}

describe.skipIf(!url)('explicit reviewed lossless legacy media repair',()=>{
  beforeAll(async()=>{
    admin = new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate(); store = await import('./store.js');
    approval = await import('./approval.js'); repair = await import('./full-repair.js');
  });
  beforeEach(async()=>{
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE stories,publications,publication_snapshots,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({publishingEnabled:true});
    await store.saveState('telegram_destination',{channelId:'-100123'});
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({id:123,is_bot:true});
    vi.spyOn(BotApi.prototype,'editCaption').mockResolvedValue(undefined);
    vi.spyOn(BotApi.prototype,'send').mockResolvedValue('1400');
    vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new Error('Text edit forbidden'));
    vi.spyOn(BotApi.prototype,'delete').mockRejectedValue(new Error('Delete forbidden'));
    vi.spyOn(BotApi.prototype,'sendMedia').mockRejectedValue(new Error('Media replacement forbidden'));
    vi.spyOn(BotApi.prototype,'sendAlbum').mockRejectedValue(new Error('New album forbidden'));
  });
  afterAll(async()=>{
    vi.restoreAllMocks(); vi.unstubAllGlobals(); if(database) await database.db.end();
    if(admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } vi.unstubAllEnvs();
  });

  it('restores the entire summary, earlier text and all seven links on the same caption when they fit',async()=>{
    const {action,desired,previous} = await fixture();
    const beforeMedia = (await database.db.query('SELECT * FROM publication_media_items')).rows;
    expect(renderCaption(previous).links).toHaveLength(3);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    const caption = vi.mocked(BotApi.prototype.editCaption).mock.calls[0]?.[2];
    expect(caption?.plainText).toContain(desired.details); expect(caption?.plainText).toContain(desired.earlier);
    expect(caption?.links.map(link=>link.url)).toEqual(sources.map(source=>source.url));
    expect(BotApi.prototype.editCaption).toHaveBeenCalledExactlyOnceWith('-100123','1286',approval.fullRepairPlan(desired)[0]);
    expect(BotApi.prototype.send).not.toHaveBeenCalled(); expect(BotApi.prototype.sendAlbum).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT * FROM publication_media_items')).rows).toEqual(beforeMedia);
    expect(await row(action.publicationId)).toMatchObject({message_id:'1286',snapshot_id:action.desiredSnapshotId,
      pending_snapshot_id:null,media_snapshot_id:action.priorSnapshotId,delivery_kind:'album'});
    expect((await textParts(action.publicationId))[0]).toMatchObject({snapshot_id:action.desiredSnapshotId,status:'sent',message_id:'1286'});
    expect((await database.db.query('SELECT response_metadata FROM request_attempts')).rows[0]?.response_metadata)
      .toMatchObject({approvalId:action.approvalId,fullContentRepair:true,snapshotId:action.desiredSnapshotId});
  });

  it('requires the dedicated invocation and never turns the approval into an automatic generation bypass',async()=>{
    const {action} = await fixture(); const publication = await row(action.publicationId);
    const delivery = await import('./delivery.js'); const actions = await import('./actions.js');
    expect(await delivery.editPublication(publication,new BotApi(),settings)).toBe(false);
    expect(await delivery.editPublication(publication,new BotApi(),settings,{approvalId:action.approvalId})).toBe(false);
    expect(await actions.executeReviewedAction(action.approvalId)).toBe(false);
    const {publicationAdmission} = await import('./freshness.js');
    expect(await database.transaction(client=>publicationAdmission(client,publication,settings,'edit',{fullContentRepair:true})))
      .toEqual({allowed:false,reason:'approval_invalid'});
    expect(BotApi.prototype.editCaption).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT * FROM judgments')).rows).toHaveLength(0);
  });

  it('reserves a same-content presentation repair against ordinary edit and navigation maintenance',async()=>{
    const {action,desired} = await fixture('Complete historical facts. '.repeat(150));
    const content={...desired,sources:[]};
    await database.db.query('UPDATE publication_snapshots SET content=$1 WHERE id=ANY($2::uuid[])',
      [JSON.stringify(content),[action.priorSnapshotId,action.desiredSnapshotId]]);
    if (!action.fullContentRepair) throw new Error('Missing repair');
    action.snapshotHash=approval.snapshotHash(content); action.fullContentRepair.priorSnapshotHash=action.snapshotHash; await save(action);
    await database.db.query('UPDATE publication_text_parts SET content=$2 WHERE publication_id=$1',
      [action.publicationId,JSON.stringify(renderCaption(content))]);
    const {editPublication}=await import('./delivery.js');
    expect(await editPublication(await row(action.publicationId),new BotApi(),settings)).toBe(false);
    await (await import('./thread-updates.js')).prepareThreadUpdates('-100123');
    expect(await row(action.publicationId)).toMatchObject({snapshot_id:action.priorSnapshotId,pending_snapshot_id:action.desiredSnapshotId});
    expect(BotApi.prototype.editCaption).not.toHaveBeenCalled();
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    expect((await textParts(action.publicationId)).map(part=>part.content)).toEqual(approval.fullRepairPlan(content));
    expect(BotApi.prototype.send).toHaveBeenCalled();
  });

  it('honors a caption connection-failure retry deadline on explicit reinvocation',async()=>{
    const {action}=await fixture();
    vi.mocked(BotApi.prototype.editCaption).mockRejectedValueOnce(new BotError('telegram_connect_failed','retryable'));
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(BotApi.prototype.editCaption).toHaveBeenCalledTimes(1);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    expect(BotApi.prototype.editCaption).toHaveBeenCalledTimes(2);
  });

  it('splits only at Telegram limits and durably delivers all overflowing text and links without truncation',async()=>{
    const {action,desired} = await fixture('Full facts & <quotes> 😀 '.repeat(430));
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    const parts = await textParts(action.publicationId); const expected = approval.fullRepairPlan(desired);
    expect(parts.map(part=>part.content)).toEqual(expected); expect(parts.length).toBeGreaterThan(2);
    expect(parts[0]?.content.plainText.length).toBeLessThanOrEqual(1024);
    expect(parts.slice(1).every(part=>part.content.plainText.length<=4096 && part.status==='sent')).toBe(true);
    expect(parts.map(part=>part.content.plainText).join('')).toBe(renderFullText(desired).map(part=>part.plainText).join(''));
    expect(new Set(parts.flatMap(part=>part.content.links.map(link=>link.url)))).toEqual(new Set(sources.map(source=>source.url)));
    expect(vi.mocked(BotApi.prototype.send).mock.calls.every(call=>call[2]==='1286')).toBe(true);
  });

  it('keeps all five factual URLs in the reviewed caption and all seven URLs including navigation in full replies',async()=>{
    const {action,desired} = await fixture('Complete researched facts. '.repeat(75));
    const overview:PublicationSnapshot = {...desired,details:'Reviewed concise overview, not a replacement for the full account.',earlier:undefined,
      sources:desired.sources.filter(source=>!source.previousPublication && !source.relatedPublication)};
    if (!action.fullContentRepair) throw new Error('Fixture repair missing');
    action.fullContentRepair.reviewedCaption = {snapshot:overview,snapshotHash:approval.snapshotHash(overview)};
    await save(action);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    const parts = await textParts(action.publicationId);
    expect(parts[0]?.content.links.map(link=>link.url)).toEqual(sources.slice(0,5).map(source=>source.url));
    expect(parts[0]?.content.plainText).not.toContain('https://t.me/');
    expect(new Set(parts.slice(1).flatMap(part=>part.content.links.map(link=>link.url)))).toEqual(new Set(sources.map(source=>source.url)));
    expect(parts[0]?.content.plainText).toContain(overview.details);
    expect(parts.slice(1).map(part=>part.content.plainText).join('')).toBe(renderFullText(desired).map(part=>part.plainText).join(''));
    expect(await store.state(approval.actionKey(action.approvalId))).toMatchObject({state:'completed'});
  });

  it('retries an explicitly rejected continuation after restart without editing the caption again',async()=>{
    const {action} = await fixture('Full facts. '.repeat(190));
    vi.mocked(BotApi.prototype.send).mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',60_000));
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(1);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_text_parts SET next_retry_at=now()-interval '1 second'");
    await (await import('./text-delivery.js')).retryPublicationText(new BotApi(),settings,'-100123');
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(true);
    expect(BotApi.prototype.editCaption).toHaveBeenCalledTimes(1); expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    expect((await textParts(action.publicationId)).every(part=>part.status==='sent')).toBe(true);
  });

  it('never resends an ambiguous continuation',async()=>{
    const {action} = await fixture('Full facts. '.repeat(190));
    vi.mocked(BotApi.prototype.send).mockRejectedValueOnce(new BotError('telegram_transport_unknown','unknown'));
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    await (await import('./text-delivery.js')).recoverPublicationText('-100123');
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    await (await import('./text-delivery.js')).retryPublicationText(new BotApi(),settings,'-100123');
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(1); expect(BotApi.prototype.editCaption).toHaveBeenCalledTimes(1);
  });

  it('leaves an ambiguous caption request for manual review and does not advance the snapshot',async()=>{
    const {action} = await fixture();
    vi.mocked(BotApi.prototype.editCaption).mockRejectedValueOnce(new BotError('telegram_transport_unknown','unknown'));
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(await row(action.publicationId)).toMatchObject({snapshot_id:action.priorSnapshotId,pending_snapshot_id:action.desiredSnapshotId});
    expect(await store.state(approval.actionKey(action.approvalId))).toMatchObject({state:'uncertain'});
    expect(BotApi.prototype.editCaption).toHaveBeenCalledTimes(1); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });

  it.each(['prior','desired','expired','version','bot','media','destination','paused','unknown','continuation','rejected'] as const)(
    'blocks %s drift or unsafe state before any Telegram content request',async mutation=>{
      const {action} = await fixture();
      if (mutation==='prior' || mutation==='desired') await database.db.query(`UPDATE publication_snapshots SET content=jsonb_set(content,'{details}','"Changed"'::jsonb) WHERE id=$1`,
        [mutation==='prior'?action.priorSnapshotId:action.desiredSnapshotId]);
      if (mutation==='expired') {action.expiresAt=new Date(Date.now()-1000).toISOString(); await save(action);}
      if (mutation==='version') await database.db.query('UPDATE stories SET content_version=2 WHERE id=$1',[action.storyId]);
      if (mutation==='bot') await database.db.query("UPDATE publications SET bot_id='999' WHERE id=$1",[action.publicationId]);
      if (mutation==='media') await database.db.query('UPDATE publications SET media_snapshot_id=NULL WHERE id=$1',[action.publicationId]);
      if (mutation==='destination') await store.saveState('telegram_destination',{channelId:'-100999'});
      if (mutation==='paused') await (await import('../settings.js')).saveSettings({publishingEnabled:false});
      if (mutation==='unknown') await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
        VALUES($1,'telegram-bot','send_part:1',1,'unknown')`,[action.publicationId]);
      if (mutation==='continuation') await database.db.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content)
        SELECT publication_id,1,snapshot_id,content FROM publication_text_parts WHERE publication_id=$1`,[action.publicationId]);
      if (mutation==='rejected') await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[action.storyId]);
      expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
      expect(BotApi.prototype.editCaption).not.toHaveBeenCalled(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    });

  it('rechecks both snapshot hashes at the actual attempt boundary after bot identity lookup',async()=>{
    const {action} = await fixture();
    vi.mocked(BotApi.prototype.identity).mockImplementationOnce(async()=>{
      await database.db.query(`UPDATE publication_snapshots SET content=jsonb_set(content,'{earlier}','"Changed after preview"'::jsonb) WHERE id=$1`,[action.priorSnapshotId]);
      return {id:123,is_bot:true};
    });
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(BotApi.prototype.editCaption).not.toHaveBeenCalled();
  });

  it('binds the reviewed overview hash and exact plan at the actual attempt boundary',async()=>{
    const {action,desired} = await fixture();
    if (!action.fullContentRepair) throw new Error('Fixture repair missing');
    const overview = {...desired,details:'Original reviewed overview',sources:sources.slice(0,5)};
    action.fullContentRepair.reviewedCaption={snapshot:overview,snapshotHash:approval.snapshotHash(overview)}; await save(action);
    vi.mocked(BotApi.prototype.identity).mockImplementationOnce(async()=>{
      if (!action.fullContentRepair) throw new Error('Fixture repair missing');
      const changed = {...overview,details:'Changed overview after review'};
      action.fullContentRepair.reviewedCaption={snapshot:changed,snapshotHash:approval.snapshotHash(changed)}; await save(action);
      return {id:123,is_bot:true};
    });
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    expect(BotApi.prototype.editCaption).not.toHaveBeenCalled();
  });

  it('keeps audit-only unverified links hidden without treating them as omitted factual sources',async()=>{
    const {desired} = await fixture();
    const content = {...desired,sources:[...desired.sources,{...sources[0]!,url:'https://t.me/channel/999',unverifiedPublication:true}]};
    expect(approval.fullRepairPlan(content).flatMap(part=>part.links.map(link=>link.url))).not.toContain('https://t.me/channel/999');
    const overview = {...desired,sources:sources.slice(0,5)};
    expect(approval.fullRepairPlan(content,{snapshot:overview,snapshotHash:approval.snapshotHash(overview)})).toHaveLength(2);
  });

  it('rejects an incomplete reviewed overview instead of silently hiding a desired URL',async()=>{
    const {action,desired} = await fixture();
    const overview = {...desired,sources:desired.sources.slice(0,3)};
    if (!action.fullContentRepair) throw new Error('Fixture repair missing');
    action.fullContentRepair.reviewedCaption={snapshot:overview,snapshotHash:approval.snapshotHash(overview)}; await save(action);
    await expect(repair.executeReviewedFullRepair(action.approvalId)).rejects.toThrow('publication_full_repair_caption_incomplete');
    expect(BotApi.prototype.editCaption).not.toHaveBeenCalled();
  });

  it('blocks continuation-plan tampering while retaining a known successful caption and original media',async()=>{
    const {action} = await fixture('Full facts. '.repeat(190));
    vi.mocked(BotApi.prototype.send).mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',1));
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query(`UPDATE publication_text_parts SET content=jsonb_set(content,'{plainText}','"tampered"'::jsonb),next_retry_at=now()-interval '1 second'
      WHERE publication_id=$1 AND part_number=1`,[action.publicationId]);
    expect(await repair.executeReviewedFullRepair(action.approvalId)).toBe(false);
    await (await import('./text-delivery.js')).retryPublicationText(new BotApi(),settings,'-100123');
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(1);
  });
});
