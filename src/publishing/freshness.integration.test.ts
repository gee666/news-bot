import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { AppSettings } from '../settings.js';
import type { Publication, StoryContent } from './store.js';
import type { GenerationReview } from '../types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `delivery_admission_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let delivery: typeof import('./delivery.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Fixture missing'); return row.id;
}
async function publication(id: string): Promise<Publication> {
  const row = (await database.db.query<Publication>(`${store.publicationEditSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!row) throw new Error('Publication missing'); return row;
}
async function fixture(status: 'prepared' | 'published' = 'prepared', review?: GenerationReview) {
  const storyId = await one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','Acme выпустила модель','Acme открыла код модели.','Acme released an open model.',7,true,false,$1,$2) RETURNING id`,
  [settings.profileVersion,settings.modelVersion]);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Acme','public') RETURNING id`,[randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,'1','https://t.me/acme/1') RETURNING id`,[source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,'original','Acme released an open model.','Acme released an open model.') RETURNING id`,[item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,item]);
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
    VALUES($1,$2,'Acme released an open model.',0) RETURNING id`,[storyId,revision]);
  const evidence = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at,metadata)
    VALUES('https://acme.example/announcement','Acme model announcement',$1,'public',now()+interval '1 day','{"status":200,"contentFormat":"text"}') RETURNING id`,
  ['Acme released an open model. The model weights and source code are available to download. '.repeat(20)]);
  await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,assessment,assessed_at,verified_at)
    VALUES($1,$2,'primary','relevant','Official announcement',now(),now())`,[storyId,evidence]);
  await acceptFixtureStories(settings);
  const receipt = await one("SELECT id FROM judgments WHERE story_id=$1 AND stage='generation_research' ORDER BY created_at DESC,id DESC LIMIT 1",[storyId]);
  if (review) await database.db.query("UPDATE judgments SET result=jsonb_set(result,'{review}',$2::jsonb) WHERE id=$1",
    [receipt, JSON.stringify(review)]);
  const story = (await database.db.query<StoryContent>('SELECT * FROM stories WHERE id=$1',[storyId])).rows[0];
  if (!story) throw new Error('Story missing');
  const content = await database.transaction(client=>store.snapshotFor(client,story));
  expect(content.sources).toHaveLength(2);
  const desired = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(content)]);
  const prior = status === 'published' ? await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
    [storyId,JSON.stringify({ ...content,headline:'Ранее',details:'Прежнее описание' })]) : desired;
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,pending_snapshot_id,destination_id,status,message_id,bot_id)
    VALUES($1,$2,$3,'-100123',$4,$5,'123') RETURNING id`,[storyId,prior,status === 'published' ? desired : null,status,status === 'published' ? '9' : null]);
  return { id,storyId,evidence,source,item,revision,mention,receipt,desired,prior,pub:await publication(id) };
}
async function protectedRows(): Promise<unknown> {
  return (await database.db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM publications p) AS publications,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM publication_snapshots p) AS snapshots,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM request_attempts p) AS attempts,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM judgments p) AS receipts`)).rows;
}
async function rejects(pub: Publication): Promise<void> {
  const before = await protectedRows();
  if (pub.status === 'published') expect(await delivery.editPublication(pub,new BotApi(),settings)).toBe(false);
  else expect(await delivery.sendPrepared(pub,new BotApi(),settings)).toBeNull();
  expect(BotApi.prototype.send).not.toHaveBeenCalled(); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
  expect(await protectedRows()).toEqual(before);
}

describe.skipIf(!url)('exact publication admission in PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString:url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js'); delivery = await import('./delivery.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE sources,stories,evidence_documents,publications,publication_snapshots,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled:true });
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id:123,is_bot:true });
    vi.spyOn(BotApi.prototype,'send').mockResolvedValue('9'); vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it.each(['send', 'edit'] as const)('persists repeated preflight %s denials without Telegram attempts or private data', async operation => {
    const f = await fixture(operation === 'edit' ? 'published' : 'prepared');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: false });
    await rejects(f.pub);
    const first = (await database.db.query<{ value: { at: string } }>("SELECT value FROM operational_state WHERE key LIKE 'publication_admission:%'")).rows[0];
    await rejects(f.pub);
    const rows = (await database.db.query<{ value: unknown }>("SELECT value FROM operational_state WHERE key LIKE 'publication_admission:%'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toEqual({ publicationId: f.id, snapshotId: f.desired, operation,
      reason: 'publishing_paused', at: first?.value.at, lastSeenAt: expect.any(String), occurrences: 2 });
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toEqual([]);
    expect(BotApi.prototype.identity).not.toHaveBeenCalled();
  });
  it('updates legacy denial diagnostics without requiring a delivery-state migration', async () => {
    const f = await fixture();
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: false });
    const at = '2026-01-01T00:00:00.000Z';
    const key = `publication_admission:${f.id}:${f.desired}:publishing_paused`;
    await store.saveState(key, { publicationId: f.id, snapshotId: f.desired, reason: 'publishing_paused', at });
    await rejects(f.pub);
    expect(await store.state(key)).toEqual({ publicationId: f.id, snapshotId: f.desired, reason: 'publishing_paused', at,
      lastSeenAt: expect.any(String), operation: 'send', occurrences: 2 });
  });
  it.each(['generation', 'score'] as const)('records %s refresh holds during normal maintenance', async condition => {
    settings = await (await import('../settings.js')).saveSettings({ minimumPublicationScore: 2 });
    const f = await fixture();
    await store.saveState('telegram_destination', { channelId: '-100123' });
    await store.saveState('bot_verified', { verified: true, destinationId: '-100123', botId: 123 });
    if (condition === 'generation') await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second'");
    else await database.db.query('UPDATE stories SET interest_score=1 WHERE id=$1', [f.storyId]);
    await (await import('./digest.js')).resumePublications(settings);
    expect((await database.db.query("SELECT value->>'reason' AS reason FROM operational_state WHERE key LIKE 'publication_admission:%'")).rows)
      .toEqual([{ reason: condition === 'generation' ? 'current_generation_missing' : 'story_ineligible' }]);
    expect((await publication(f.id)).status).toBe('prepared');
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toEqual([]);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('publishes a failed-review summary with its Russian warning', async () => {
    const f = await fixture('prepared', { supported: false, reason: 'Версия не подтверждена источником' });
    expect(await (await import('../pipeline/generation-freshness.js')).generationIsCurrent(f.storyId, settings)).toBe(true);
    expect(await delivery.sendPrepared(f.pub, new BotApi(), settings)).toBe('9');
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect(vi.mocked(BotApi.prototype.send).mock.calls[0]?.[1].text).toContain('Заметки проверяющего: Версия не подтверждена источником');
    expect((await publication(f.id)).status).toBe('published');
  });
  it.each(['input', 'model'] as const)('does not let a newer wrong-%s receipt invalidate unchanged output', async mismatch => {
    const f = await fixture();
    await database.db.query(`INSERT INTO judgments(story_id,stage,input_hash,model_key,prompt_version,model_version,result,expires_at,created_at)
      SELECT story_id,stage,CASE WHEN $2='input' THEN input_hash||'-other' ELSE input_hash END,
        CASE WHEN $2='model' THEN model_key||'-other' ELSE model_key END,prompt_version,model_version,
        result,expires_at,now()+interval '1 second'
      FROM judgments WHERE id=$1`, [f.receipt, mismatch]);
    expect(await delivery.sendPrepared(f.pub, new BotApi(), settings)).toBe('9');
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it('keeps sent text immutable when a later draft summary changes, but still edits sources',async () => {
    const f = await fixture(); expect(await delivery.sendPrepared(f.pub,new BotApi(),settings)).toBe('9');
    expect(await delivery.sendPrepared(await publication(f.id),new BotApi(),settings)).toBeNull();
    await database.db.query("UPDATE stories SET summary='Acme также выпустила документацию.' WHERE id=$1",[f.storyId]);
    await acceptFixtureStories(settings);
    const updates = await import('./updates.js'); await updates.prepareUpdates(settings,'-100123',undefined,{ sourceRepair: true });
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect((await publication(f.id)).content).toMatchObject({details:'Acme открыла код модели.'});
    await database.db.query("UPDATE evidence_documents SET title='New source label' WHERE id=$1",[f.evidence]);
    await updates.prepareUpdates(settings,'-100123',undefined,{ sourceRepair: true });
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.send).toHaveBeenCalledOnce(); expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
  });
  it('uses the latest reaccepted evidence signature, stages an immutable source change and edits once',async()=>{
    const f=await fixture('published');
    await database.db.query("UPDATE evidence_documents SET title='Updated verified announcement' WHERE id=$1",[f.evidence]);
    await acceptFixtureStories(settings);
    const fresh=await import('../pipeline/generation-freshness.js');
    expect(await fresh.generationIsCurrent(f.storyId,settings)).toBe(true);
    expect(await fresh.generationIsCurrent(f.storyId,settings,undefined,f.receipt)).toBe(false);
    const updates=await import('./updates.js'); await updates.prepareUpdates(settings,'-100123',undefined,{ sourceRepair: true });
    expect((await publication(f.id)).pending_snapshot_id).not.toBe(f.desired);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT id FROM publication_snapshots WHERE id=ANY($1::uuid[])',[[f.prior,f.desired]])).rows).toHaveLength(2);
    expect((await publication(f.id)).content).toMatchObject({sources:expect.arrayContaining([{ label:'Updated verified announcement',url:'https://acme.example/announcement',primary:true,access:'public',classification:'relevant' }])});
  });
  it.each(['v8','absent','expired','wrong_model','wrong_profile','wrong_input','wrong_output','purged','signature'] as const)(
    'rejects %s receipts without dispatch or rewriting originals',async mutation => {
      const f = await fixture();
      if (mutation === 'v8') await database.db.query("UPDATE judgments SET prompt_version='generation-v8'");
      if (mutation === 'absent' || mutation === 'purged') await database.db.query('DELETE FROM judgments');
      if (mutation === 'expired') await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second'");
      if (mutation === 'wrong_model') await database.db.query("UPDATE judgments SET model_key='other/model'");
      if (mutation === 'wrong_profile') await database.db.query('UPDATE stories SET profile_version=profile_version+1');
      if (mutation === 'wrong_input') await database.db.query('UPDATE stories SET content_version=content_version+1');
      if (mutation === 'wrong_output') await database.db.query("UPDATE judgments SET result=result||'{\"headline\":\"Different\"}'::jsonb");
      if (mutation === 'signature') await database.db.query("UPDATE judgments SET result=result||'{\"evidenceSignature\":\"Different\"}'::jsonb");
      await rejects(f.pub);
      await store.prepareDigest(settings,'-100123'); expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(1);
    });
  it.each(['unread','restricted','error','login','uncertain','irrelevant','expired','superseded','authority','title'] as const)(
    'independently rejects changed %s sources even with a newly stamped current receipt',async mutation => {
      const f = await fixture('published');
      if (mutation === 'unread') await database.db.query('UPDATE evidence_documents SET content=NULL');
      if (mutation === 'restricted') await database.db.query("UPDATE evidence_documents SET access='restricted'");
      if (mutation === 'error') await database.db.query("UPDATE evidence_documents SET metadata='{\"status\":503,\"error\":\"upstream\"}'");
      if (mutation === 'login') await database.db.query("UPDATE evidence_documents SET content='Sign in to continue. Log in to view this content.'");
      if (mutation === 'uncertain' || mutation === 'irrelevant') await database.db.query('UPDATE story_evidence SET relevance=$1',[mutation]);
      if (mutation === 'expired') await database.db.query("UPDATE evidence_documents SET expires_at=now()-interval '1 second'");
      if (mutation === 'superseded') await database.db.query('UPDATE story_evidence SET superseded_at=now()');
      if (mutation === 'authority') await database.db.query("UPDATE story_evidence SET role='supporting'");
      if (mutation === 'title') await database.db.query("UPDATE evidence_documents SET title='A changed source title'");
      await acceptFixtureStories(settings); await rejects(f.pub);
    });
  it('rejects a changed source snapshot without imposing an evidence-contract gate', async () => {
    const f = await fixture();
    await database.db.query(`UPDATE publication_snapshots SET content=jsonb_set(content,'{sources}','[]'::jsonb) WHERE id=$1`, [f.desired]);
    expect(await (await import('../pipeline/generation-freshness.js')).generationIsCurrent(f.storyId, settings)).toBe(true);
    const current = await publication(f.id);
    const { publicationAdmission } = await import('./freshness.js');
    expect(await database.transaction(client => publicationAdmission(client, current, settings, 'send')))
      .toEqual({ allowed: false, reason: 'snapshot_changed' });
    await rejects(current);
  });
  it.each(['pointer','input','settings','canonical','retained','malformed'] as const)('fails closed after %s drift',async mutation => {
    const f = await fixture('published');
    if (mutation === 'pointer') await database.db.query('UPDATE publications SET pending_snapshot_id=NULL');
    if (mutation === 'input') await database.db.query("UPDATE story_mentions SET text='A different collected event'");
    if (mutation === 'settings') await (await import('../settings.js')).saveSettings({ researchMaxPages:settings.researchMaxPages+1 });
    if (mutation === 'canonical') {
      const other = await fixture();
      await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[f.storyId,other.storyId]);
    }
    if (mutation === 'retained') await database.db.query('DELETE FROM stories WHERE id=$1',[f.storyId]);
    if (mutation === 'malformed') await database.db.query('UPDATE publication_snapshots SET content=$1 WHERE id=$2',
      [JSON.stringify({ headline:'Broken',score:7,details:'Details',detailsKind:'summary',sources:[{ label:'Broken' }] }),f.desired]);
    await rejects(f.pub);
  });
  it.each(['marker','metadata'] as const)('keeps an otherwise current story blocked by item quarantine %s',async kind=>{
    const f=await fixture();
    if(kind==='marker'){
      const item=(await database.db.query<{id:string}>('SELECT r.item_id AS id FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id WHERE m.story_id=$1',[f.storyId])).rows[0];
      if(!item) throw new Error('Missing fixture item');
      await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',[`pipeline_failed_item:${item.id}`,JSON.stringify({itemId:item.id,storyIds:[f.storyId]})]);
    }else await database.db.query(`UPDATE item_revisions r SET metadata=metadata||'{"pipelineFailure":true}'::jsonb
      WHERE EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id=$1)`,[f.storyId]);
    await rejects(f.pub);
  });
  it('refuses an active association writer without deadlock, inference or dispatch',async()=>{
    const f=await fixture('published');const writer=await database.db.connect();
    try{
      await writer.query('BEGIN');
      await writer.query('UPDATE story_evidence SET role=role WHERE story_id=$1',[f.storyId]);
      await rejects(f.pub);
    }finally{await writer.query('ROLLBACK');writer.release();}
    expect(await delivery.editPublication(f.pub,new BotApi(),settings)).toBe(true);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
  });
  it('keeps unsafe historical send retries blocked even if their persisted publication still says prepared',async()=>{
    const f=await fixture();
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code)
      VALUES($1,'telegram-bot','send',1,'retryable','telegram_transport_unknown')`,[f.id]);
    await rejects(f.pub);
  });
  it('rechecks settings at the durable attempt boundary after identity preflight',async () => {
    const f = await fixture();
    vi.spyOn(BotApi.prototype,'identity').mockImplementation(async()=>{
      await (await import('../settings.js')).saveSettings({ publishingEnabled:false }); return { id:123,is_bot:true };
    });
    await rejects(f.pub);
    expect((await database.db.query("SELECT value->>'reason' AS reason FROM operational_state WHERE key LIKE 'publication_admission:%'")).rows)
      .toEqual([{ reason:'settings_changed' }]);
  });
  it('keeps unknown sends historical and never uses reconciliation as current-policy adoption',async () => {
    const f = await fixture();
    await database.db.query("UPDATE publications SET status='uncertain'");
    await database.db.query("UPDATE judgments SET prompt_version='generation-v8'");
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
      VALUES($1,'telegram-bot','send',1,'unknown')`,[f.id]);
    expect(await delivery.sendPrepared(await publication(f.id),new BotApi(),settings)).toBeNull();
    expect(await delivery.reconcile(await publication(f.id),settings,async()=> '9')).toBe(true);
    expect(await (await import('../pipeline/generation-freshness.js')).generationIsCurrent(f.storyId,settings)).toBe(false);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it.each(['match','missing','different','ambiguous'] as const)('reads unknown edits: %s, never dispatching an edit',async outcome => {
    const f = await fixture('published');
    const { render } = await import('./render.js'); const { sendMetadata } = await import('./reconciliation.js');
    const metadata = { ...sendMetadata(render(f.pub.content)),snapshotId:f.desired };
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata,next_retry_at)
      VALUES($1,'telegram-bot','edit',1,'unknown',$2,now()-interval '1 second')`,[f.id,JSON.stringify(metadata)]);
    if (outcome === 'ambiguous') await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      VALUES($1,'telegram-bot','edit',2,'unknown',$2)`,[f.id,JSON.stringify(metadata)]);
    const reader = vi.fn().mockResolvedValue(outcome === 'match' ? metadata.fingerprint : outcome === 'different' ? 'different' : null);
    const before = await protectedRows();
    expect(await (await import('./edit-reconciliation.js')).reconcileUnknownEdit(f.pub,reader)).toBe(outcome === 'match');
    if (outcome === 'match') expect((await publication(f.id)).pending_snapshot_id).toBeNull();
    else expect(await protectedRows()).toEqual(before);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled();
  });
  it('allows only registered explicit technical verification while ordinary publishing is paused',async () => {
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled:false });
    const test = await store.testPublication('-100123'); const api = new BotApi();
    expect(await delivery.sendPrepared(test,api,settings,{ verificationTest:true })).toBeNull();
    await store.saveState('bot_verification_test',{ publicationId:test.id,destinationId:'-100123',botId:123 });
    expect(await delivery.sendPrepared(test,api,settings)).toBeNull();
    expect(await delivery.sendPrepared(test,api,settings,{ verificationTest:true })).toBe('9');
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
});
