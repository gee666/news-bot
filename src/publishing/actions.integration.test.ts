import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { BotApi,BotError } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { AppSettings } from '../settings.js';
import type { Publication } from './store.js';
import type { ReviewedAction } from './approval.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `approved_actions_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let store:typeof import('./store.js');
let approval:typeof import('./approval.js');
let actions:typeof import('./actions.js');
let settings:AppSettings;
async function one(sql:string,values:unknown[]=[]):Promise<string> {
  const row = (await database.db.query<{id:string}>(sql,values)).rows[0]; if(!row) throw new Error('Fixture missing'); return row.id;
}
async function fixture() {
  const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','Accepted event','Accepted details',7,true,false,$1,$2) RETURNING id`,[settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings);
  const receiptId = await one("SELECT id FROM judgments WHERE story_id=$1 AND stage='generation_research' LIMIT 1",[storyId]);
  const previous = { headline:'Old event',details:'Old details',score:7,detailsKind:'summary',sources:[] };
  const story = (await database.db.query<import('./content.js').StoryContent>('SELECT * FROM stories WHERE id=$1', [storyId])).rows[0];
  if (!story) throw new Error('Missing fixture story');
  const desired = await store.snapshotFor(database.db, story);
  const priorSnapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(previous)]);
  const desiredSnapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(desired)]);
  const publicationId = await one(`INSERT INTO publications(story_id,snapshot_id,pending_snapshot_id,destination_id,status,message_id,bot_id)
    VALUES($1,$2,$3,'-100123','published','177','123') RETURNING id`,[storyId,priorSnapshotId,desiredSnapshotId]);
  const record:ReviewedAction = { approvalId:randomUUID(),state:'approved',operation:'edit',publicationId,destinationId:'-100123',messageId:'177',
    priorSnapshotId,desiredSnapshotId,snapshotHash:approval.snapshotHash(desired),storyId,contentVersion:1,receiptId,
    expiresAt:new Date(Date.now()+60_000).toISOString(),coordinator:'test coordinator / independent reviewer' };
  return record;
}
async function spuriousFixture(){
  const record:ReviewedAction={...await fixture(),operation:'delete',messageId:'178',desiredSnapshotId:null,receiptId:null};
  await database.db.query("UPDATE stories SET status='rejected',headline=NULL,summary=NULL WHERE id=$1",[record.storyId]);
  await database.db.query("UPDATE publications SET message_id='178',pending_snapshot_id=NULL WHERE id=$1",[record.publicationId]);
  record.snapshotHash=approval.snapshotHash((await row(record.publicationId)).content);
  return record;
}
async function albumRemovalFixture(): Promise<ReviewedAction> {
  const record = await spuriousFixture();
  await database.db.query("UPDATE publications SET delivery_kind='album',media_status='complete' WHERE id=$1", [record.publicationId]);
  const batchId = await one("INSERT INTO publication_media_batches(publication_id,batch_number,status) VALUES($1,0,'sent') RETURNING id", [record.publicationId]);
  for (const ordinal of [0,1,2]) await database.db.query(`INSERT INTO publication_media_items(batch_id,ordinal,type,mime_type,digest,message_id)
    VALUES($1,$2,'image','image/png',$3,$4)`, [batchId,ordinal,`synthetic${ordinal}`,String(178+ordinal)]);
  await save(record);
  return record;
}
async function save(record:ReviewedAction):Promise<void> { await store.saveState(approval.actionKey(record.approvalId),record); }
async function row(id:string):Promise<Publication> {
  const result = (await database.db.query<Publication>(`${store.publicationEditSelect} WHERE p.id=$1`,[id])).rows[0];
  if(!result) throw new Error('Publication missing'); return result;
}

describe.skipIf(!url)('bounded reviewed publication actions under pause',()=>{
  beforeAll(async()=>{
    admin = new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate(); store = await import('./store.js');
    approval = await import('./approval.js'); actions = await import('./actions.js');
  });
  beforeEach(async()=>{
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE stories,publications,publication_snapshots,request_attempts CASCADE'); await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled:false });
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id:123,is_bot:true });
    vi.spyOn(BotApi.prototype,'send').mockRejectedValue(new Error('New sends forbidden'));
    vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined); vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
  });
  afterAll(async()=>{
    vi.unstubAllGlobals(); vi.restoreAllMocks(); if(database) await database.db.end();
    if(admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } vi.unstubAllEnvs();
  });
  it('edits only the exact approved existing message once and preserves prior snapshots/receipts',async()=>{
    const record = await fixture();
    const delivery = await import('./delivery.js'); expect(await delivery.editPublication(await row(record.publicationId),new BotApi(),settings)).toBe(false);
    await save(record); expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce(); expect(BotApi.prototype.send).not.toHaveBeenCalled(); expect(BotApi.prototype.delete).not.toHaveBeenCalled();
    expect((await row(record.publicationId)).snapshot_id).toBe(record.desiredSnapshotId);
    expect((await database.db.query('SELECT id FROM publication_snapshots')).rows).toHaveLength(2);
    expect((await database.db.query('SELECT id FROM judgments WHERE id=$1',[record.receiptId])).rows).toHaveLength(1);
    expect((await database.db.query('SELECT status,response_metadata FROM request_attempts')).rows[0]).toMatchObject({status:'succeeded',response_metadata:{approvalId:record.approvalId}});
    expect(await store.state(approval.actionKey(record.approvalId))).toMatchObject({state:'completed'});
  });
  it.each(['expired','receipt','message','snapshot','version','hash'] as const)('refuses %s drift with zero requests',async mutation=>{
    const record = await fixture();
    if(mutation === 'expired') record.expiresAt=new Date(Date.now()-1_000).toISOString();
    if(mutation === 'receipt') record.receiptId=randomUUID();
    if(mutation === 'message') record.messageId='112';
    if(mutation === 'snapshot') record.priorSnapshotId=randomUUID();
    if(mutation === 'version') record.contentVersion++;
    if(mutation === 'hash') record.snapshotHash='0'.repeat(64);
    await save(record); expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toEqual([]);
  });
  it('reconstructs an approved snapshot from its pinned receipt despite a newer same-output review', async () => {
    const record = await fixture();
    await database.db.query(`INSERT INTO judgments(story_id,stage,input_hash,model_key,prompt_version,model_version,result,expires_at,created_at)
      SELECT story_id,stage,input_hash,model_key,prompt_version,model_version,
        jsonb_set(result,'{review}','{"supported":false,"reason":"Версия не подтверждена"}'::jsonb),expires_at,now()+interval '1 second'
      FROM judgments WHERE id=$1`, [record.receiptId]);
    const story = (await database.db.query<import('./content.js').StoryContent>('SELECT * FROM stories WHERE id=$1', [record.storyId])).rows[0];
    if (!story) throw new Error('Missing approved story');
    const fresh = await import('../pipeline/generation-freshness.js');
    expect(await fresh.generationIsCurrent(record.storyId, settings)).toBe(true);
    expect(await fresh.generationIsCurrent(record.storyId, settings, undefined, record.receiptId ?? undefined)).toBe(true);
    const latest = await store.snapshotFor(database.db, story);
    const pinned = await store.snapshotFor(database.db, story, record.receiptId ?? undefined);
    expect(latest.review?.supported).toBe(false);
    expect(pinned.review?.supported).toBe(true);
    expect(approval.snapshotHash(latest)).not.toBe(record.snapshotHash);
    expect(approval.snapshotHash(pinned)).toBe(record.snapshotHash);
    await save(record);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await row(record.publicationId)).snapshot_id).toBe(record.desiredSnapshotId);
  });
  it.each(['input', 'model', 'expired'] as const)('does not borrow another receipt when pinned %s validation fails', async mutation => {
    const record = await fixture();
    await acceptFixtureStories(settings);
    if (mutation === 'input') await database.db.query("UPDATE judgments SET input_hash='other' WHERE id=$1", [record.receiptId]);
    if (mutation === 'model') await database.db.query("UPDATE judgments SET model_key='other/model' WHERE id=$1", [record.receiptId]);
    if (mutation === 'expired') await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE id=$1", [record.receiptId]);
    await save(record);
    expect(await (await import('../pipeline/generation-freshness.js')).generationIsCurrent(record.storyId, settings)).toBe(true);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toEqual([]);
  });
  it('cannot borrow a different valid receipt when the specifically approved receipt is stale',async()=>{
    const record=await fixture();
    await database.db.query("UPDATE judgments SET input_hash='stale' WHERE id=$1",[record.receiptId]);
    await acceptFixtureStories(settings); await save(record);
    expect(await (await import('../pipeline/generation-freshness.js')).generationIsCurrent(record.storyId,settings)).toBe(true);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled(); expect((await database.db.query('SELECT id FROM request_attempts')).rows).toEqual([]);
  });
  it('keeps an approved unknown edit uncertain without resetting or retrying the action',async()=>{
    const record = await fixture(); await save(record);
    vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce(); expect(await store.state(approval.actionKey(record.approvalId))).toMatchObject({state:'uncertain'});
    expect((await database.db.query('SELECT status FROM request_attempts')).rows).toEqual([{status:'unknown'}]);
  });
  it.each(['canonical','approval','snapshot'] as const)('rechecks delete %s at its durable attempt boundary',async mutation=>{
    const record=await spuriousFixture();await save(record);
    vi.spyOn(BotApi.prototype,'identity').mockImplementation(async()=>{
      if(mutation==='canonical'){
        const canonical=await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
        await database.db.query('INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id) VALUES($1,$2,$3)',[record.publicationId,record.storyId,canonical]);
      }else if(mutation==='approval') await database.db.query(`UPDATE operational_state SET value=jsonb_set(value,'{coordinator}','"changed"'::jsonb) WHERE key=$1`,[approval.actionKey(record.approvalId)]);
      else await database.db.query(`UPDATE publication_snapshots SET content=jsonb_set(content,'{details}','"Changed"'::jsonb) WHERE id=$1`,[record.priorSnapshotId]);
      return {id:123,is_bot:true};
    });
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(BotApi.prototype.delete).not.toHaveBeenCalled();expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toEqual([]);
  });
  it('deletes only an explicitly approved spurious message and retains news/publication/snapshot history',async()=>{
    const record=await spuriousFixture();await save(record);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true); expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(BotApi.prototype.delete).toHaveBeenCalledExactlyOnceWith('-100123','178'); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect((await row(record.publicationId)).snapshot_id).toBe(record.priorSnapshotId); expect((await row(record.publicationId)).status).toBe('published');
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(1); expect((await database.db.query('SELECT id FROM publication_snapshots')).rows).toHaveLength(2);
    expect(await store.state(`publication_removal:${record.publicationId}`)).toMatchObject({state:'deleted',messageId:'178'});
    expect((await database.db.query('SELECT status,operation FROM request_attempts')).rows).toEqual([{status:'succeeded',operation:'delete'}]);
    const updates = await import('./updates.js'); expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('resumes a partial album deletion after an explicit 429 under the same unexpired approval', async () => {
    const record = await albumRemovalFixture();
    const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000));
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(remove.mock.calls.map(call => call[1])).toEqual(['179','180']);
    expect(await store.state(approval.actionKey(record.approvalId))).toMatchObject({state:'approved'});
    expect(await store.state(`publication_removal:${record.publicationId}`)).toMatchObject({state:'retryable',approvalId:record.approvalId});
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false); expect(remove).toHaveBeenCalledTimes(2);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    remove.mockResolvedValue(undefined);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(remove.mock.calls.map(call => call[1])).toEqual(['179','180','180','178']);
    expect((await database.db.query('SELECT deleted_at FROM publication_media_items')).rows.every(row => row.deleted_at)).toBe(true);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true); expect(remove).toHaveBeenCalledTimes(4);
  });
  it('retains retry authorization after a restart immediately following the atomic 429 failure commit', async () => {
    const record = await albumRemovalFixture();
    const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000));
    const delivery = await import('./delivery.js');
    const recordFailure = delivery.recordFailure;
    const interruption = vi.spyOn(delivery,'recordFailure').mockImplementation(async (...args) => {
      await recordFailure(...args);
      throw new Error('Synthetic restart immediately after failure commit');
    });
    await expect(actions.executeReviewedAction(record.approvalId)).rejects.toThrow('Synthetic restart immediately after failure commit');
    interruption.mockRestore();
    expect((await database.db.query("SELECT status,error_code FROM request_attempts WHERE operation='delete'")).rows)
      .toEqual([{status:'retryable',error_code:'telegram_rate_limit'}]);
    expect(await store.state(approval.actionKey(record.approvalId))).toMatchObject({state:'approved'});
    expect(await store.state(`publication_removal:${record.publicationId}`)).toMatchObject({state:'retryable',approvalId:record.approvalId});
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false); expect(remove).toHaveBeenCalledTimes(2);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    remove.mockResolvedValue(undefined);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(true);
    expect(remove.mock.calls.map(call => call[1])).toEqual(['179','180','180','178']);
    expect((await database.db.query('SELECT deleted_at FROM publication_media_items')).rows.every(row => row.deleted_at)).toBe(true);
  });
  it.each(['expired','snapshot'] as const)('does not resume a partially deleted album after approved %s drift', async mutation => {
    const record = await albumRemovalFixture();
    const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',1000));
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    if (mutation === 'expired') {
      record.expiresAt = new Date(Date.now()-1000).toISOString(); await save(record);
    } else await database.db.query(`UPDATE publication_snapshots SET content=jsonb_set(content,'{details}','"Changed"'::jsonb) WHERE id=$1`, [record.priorSnapshotId]);
    remove.mockResolvedValue(undefined);
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false); expect(remove).toHaveBeenCalledTimes(2);
  });
  it('leaves an unknown partial album deletion for manual review rather than authorizing another request', async () => {
    const record = await albumRemovalFixture();
    const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new BotError('telegram_transport_unknown','unknown'));
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false);
    expect(await store.state(approval.actionKey(record.approvalId))).toMatchObject({state:'uncertain'});
    expect(await actions.executeReviewedAction(record.approvalId)).toBe(false); expect(remove).toHaveBeenCalledTimes(2);
  });

});
