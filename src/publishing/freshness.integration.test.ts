import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
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
  await acceptFixtureStories(settings,[storyId]);
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
    await store.saveState('telegram_destination',{channelId:'-100123'});
    await store.saveState('bot_verified',{verified:true,destinationId:'-100123',botId:123});
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id:123,is_bot:true });
    vi.spyOn(BotApi.prototype,'send').mockResolvedValue('9'); vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('checks preparation in one SQL query without rendering or reading source inventories', async () => {
    const f = await fixture();
    const query = vi.spyOn(database.db,'query');
    const { publicationAdmission } = await import('./freshness.js');
    expect(await publicationAdmission(database.db,f.pub,settings,'send')).toEqual({allowed:true});
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).not.toContain('FOR SHARE NOWAIT');
  });
  it.each(['pause','destination','bot','version','generation','failed','removed','quarantine'] as const)(
    'holds dispatch after %s changes', async mutation => {
      const f = await fixture();
      if (mutation === 'pause') await (await import('../settings.js')).saveSettings({publishingEnabled:false});
      if (mutation === 'destination') await store.saveState('telegram_destination',{channelId:'-100999'});
      if (mutation === 'bot') await store.saveState('bot_verified',{verified:true,destinationId:'-100123',botId:456});
      if (mutation === 'version') await database.db.query('UPDATE stories SET content_version=content_version+1 WHERE id=$1',[f.storyId]);
      if (mutation === 'generation') await acceptFixtureStories(settings,[f.storyId]);
      if (mutation === 'failed') await database.db.query("UPDATE stories SET status='failed' WHERE id=$1",[f.storyId]);
      if (mutation === 'removed') await store.saveState(`publication_removal:${f.id}`,{});
      if (mutation === 'quarantine') await database.db.query(`UPDATE item_revisions SET metadata='{"pipelineFailure":true}' WHERE id=$1`,[f.revision]);
      expect(await delivery.sendPrepared(f.pub,new BotApi(),settings)).toBeNull();
      expect(BotApi.prototype.send).not.toHaveBeenCalled();
      expect((await database.db.query('SELECT id FROM request_attempts')).rows).toHaveLength(0);
    });
  it('does not revalidate accepted generation prompts or source titles at dispatch', async () => {
    const f = await fixture();
    await database.db.query("UPDATE evidence_documents SET title='New title' WHERE id=$1",[f.evidence]);
    await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second',prompt_version='old-prompt' WHERE id=$1",[f.receipt]);
    expect(await delivery.sendPrepared(f.pub,new BotApi(),settings)).toBe('9');
  });
  it('checks again between identity preflight and the durable attempt', async () => {
    const f = await fixture();
    vi.mocked(BotApi.prototype.identity).mockImplementation(async () => {
      await (await import('../settings.js')).saveSettings({publishingEnabled:false});
      return {id:123,is_bot:true};
    });
    expect(await delivery.sendPrepared(f.pub,new BotApi(),settings)).toBeNull();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('edits a new navigation snapshot of a retained post without resending it', async () => {
    const f = await fixture('published');
    expect(await delivery.editPublication(f.pub,new BotApi(),settings)).toBe(true);
    expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it.each(['text','album'] as const)('skips oversized %s edits with the navigation diagnostic',async kind => {
    const f = await fixture('published');
    await database.db.query(`UPDATE publications SET delivery_kind=$2 WHERE id=$1`,[f.id,kind]);
    await database.db.query(`UPDATE publication_snapshots SET content=jsonb_set(content,'{details}',to_jsonb($2::text)) WHERE id=$1`,
      [f.desired,'Long body '.repeat(kind==='album'?130:600)]);
    const caption = vi.spyOn(BotApi.prototype,'editCaption');
    expect(await delivery.editPublication(await publication(f.id),new BotApi(),settings)).toBe(false);
    expect(caption).not.toHaveBeenCalled(); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT error_code FROM publications WHERE id=$1',[f.id])).rows)
      .toEqual([{error_code:'publication_navigation_requires_new_edition'}]);
    expect((await database.db.query('SELECT id FROM request_attempts')).rows).toHaveLength(0);
  });
  it('keeps UPD and related links inside an ordinary text edit', async () => {
    const f = await fixture('published');
    const source = {url:'https://t.me/c/123/20',label:'Related edition',primary:false,access:'public',classification:'relevant',relatedPublication:true};
    await database.db.query(`UPDATE publication_snapshots SET content=content||jsonb_build_object(
      'updatedTo','https://t.me/c/123/30','sources',content->'sources'||$2::jsonb) WHERE id=$1`,[f.desired,JSON.stringify([source])]);
    expect(await delivery.editPublication(await publication(f.id),new BotApi(),settings)).toBe(true);
    const message = vi.mocked(BotApi.prototype.edit).mock.calls[0]?.[2];
    expect(message?.plainText).toContain('UPD:');
    expect(message?.links.map(link=>link.url)).toEqual(expect.arrayContaining([source.url,'https://t.me/c/123/30']));
    expect(message?.plainText).toContain('Acme открыла код модели.');
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('edits old album posts with editMessageCaption only', async () => {
    const f = await fixture('published');
    await database.db.query("UPDATE publications SET delivery_kind='album' WHERE id=$1",[f.id]);
    const caption = vi.spyOn(BotApi.prototype,'editCaption').mockResolvedValue(undefined);
    expect(await delivery.editPublication(await publication(f.id),new BotApi(),settings)).toBe(true);
    expect(caption).toHaveBeenCalledOnce(); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect(await delivery.sendPrepared(await publication(f.id),new BotApi(),settings)).toBeNull();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it.each(['match','missing','different','ambiguous'] as const)('reconciles unknown edits: %s, never dispatching an edit',async outcome => {
    const f = await fixture('published');
    const { render } = await import('./render.js'); const { sendMetadata } = await import('./reconciliation.js');
    const metadata = { ...sendMetadata(render(f.pub.content)),snapshotId:f.desired };
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata,next_retry_at)
      VALUES($1,'telegram-bot','edit',1,'unknown',$2,now()-interval '1 second')`,[f.id,JSON.stringify(metadata)]);
    if (outcome === 'ambiguous') await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      VALUES($1,'telegram-bot','edit',2,'unknown',$2)`,[f.id,JSON.stringify(metadata)]);
    const reader = vi.fn().mockResolvedValue(outcome === 'match' ? metadata.fingerprint : outcome === 'different' ? 'different' : null);
    expect(await (await import('./edit-reconciliation.js')).reconcileUnknownEdit(f.pub,reader)).toBe(outcome === 'match');
    expect((await publication(f.id)).pending_snapshot_id).toBe(outcome === 'match' || outcome === 'ambiguous' ? null : f.desired);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('retires an orphan admission-denied edit once and lets later UPD/correction edits dispatch',async () => {
    const orphan=await fixture('published');
    await database.db.query("UPDATE publications SET message_id='928' WHERE id=$1",[orphan.id]);
    const upd=await fixture('published');
    await database.db.query("UPDATE publications SET message_id='2076' WHERE id=$1",[upd.id]);
    const correction=await fixture('published');
    await database.db.query("UPDATE publications SET message_id='2064' WHERE id=$1",[correction.id]);
    await database.db.query('DELETE FROM stories WHERE id=$1',[orphan.storyId]);
    await database.db.query(`UPDATE publication_snapshots SET content=content||'{"updatedTo":"https://t.me/c/123/2101"}'::jsonb WHERE id=$1`,[orphan.prior]);
    const {desiredNavigation}=await import('./navigation.js');
    const sent=(await database.db.query<{content:unknown}>('SELECT content FROM publication_snapshots WHERE id=$1',[orphan.prior])).rows[0]?.content;
    const {publicationSnapshotSchema}=await import('../types.js');
    const desired=await desiredNavigation(database.db,await publication(orphan.id),publicationSnapshotSchema.parse(sent));
    await database.db.query('UPDATE publication_snapshots SET content=$2 WHERE id=$1',[orphan.desired,JSON.stringify(desired)]);
    await database.db.query("UPDATE publications SET created_at=now()-interval '1 day' WHERE id=$1",[orphan.id]);
    const { retryEdits }=await import('./updates.js');
    expect(await retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect((await publication(orphan.id)).pending_snapshot_id).toBeNull();
    await (await import('./thread-updates.js')).prepareThreadUpdates('-100123');
    expect((await publication(orphan.id)).pending_snapshot_id).toBeNull();
    expect(await store.state(`publication_edit_settled:${orphan.id}:${orphan.desired}`)).toMatchObject({snapshotId:orphan.desired});
    expect(await retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    expect(await retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    expect(BotApi.prototype.edit).toHaveBeenCalledTimes(2);
    expect((await publication(upd.id)).pending_snapshot_id).toBeNull();
    expect((await publication(correction.id)).pending_snapshot_id).toBeNull();
    expect((await database.db.query("SELECT value->>'occurrences' AS n FROM operational_state WHERE key LIKE $1",[`publication_admission:${orphan.id}:%`])).rows)
      .toEqual([{n:'1'}]);
  });
  it('stops known edit rejections after the configured snapshot budget and preserves the global cooldown',async () => {
    const f=await fixture('published'); const api=new BotApi();
    vi.mocked(BotApi.prototype.edit).mockRejectedValue(new BotError('telegram_rate_limit','retryable',60_000));
    for(let attempt=1;attempt<=settings.requestMaxAttempts;attempt++) {
      expect(await delivery.editPublication(await publication(f.id),api,settings)).toBe(false);
      if(attempt<settings.requestMaxAttempts) await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second' WHERE publication_id=$1",[f.id]);
    }
    expect(BotApi.prototype.edit).toHaveBeenCalledTimes(settings.requestMaxAttempts);
    expect((await publication(f.id)).pending_snapshot_id).toBeNull();
    expect(await store.rateLimited()).toBe(true);
    const { retryEdits }=await import('./updates.js');
    expect(await retryEdits(api,settings,'-100123')).toBe(0);
    expect(BotApi.prototype.edit).toHaveBeenCalledTimes(settings.requestMaxAttempts);
  });
  it('bounds unknown-edit reconciliation, retires its snapshot and never resends after exhaustion',async () => {
    const f=await fixture('published');
    const {render}=await import('./render.js'); const {sendMetadata}=await import('./reconciliation.js');
    const meta={...sendMetadata(render(f.pub.content)),snapshotId:f.desired};
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      VALUES($1,'telegram-bot','edit',1,'unknown',$2)`,[f.id,JSON.stringify(meta)]);
    const {reconcileUnknownEdit}=await import('./edit-reconciliation.js'); const reader=vi.fn().mockResolvedValue(null);
    for(let attempt=1;attempt<=settings.requestMaxAttempts;attempt++) {
      expect(await reconcileUnknownEdit(await publication(f.id),reader,settings)).toBe(false);
      if(attempt<settings.requestMaxAttempts) {
        expect((await database.db.query('SELECT next_retry_at FROM request_attempts WHERE publication_id=$1',[f.id])).rows[0]?.next_retry_at.getTime()).toBeGreaterThan(Date.now());
        expect(await reconcileUnknownEdit(await publication(f.id),reader,settings)).toBe(false);
        await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second' WHERE publication_id=$1",[f.id]);
      }
    }
    expect(reader).toHaveBeenCalledTimes(settings.requestMaxAttempts);
    expect((await publication(f.id)).pending_snapshot_id).toBeNull();
    // Even a direct call with the old snapshot cannot bypass the terminal ambiguity marker.
    expect(await delivery.editPublication(f.pub,new BotApi(),settings)).toBe(false);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled();
  });
  it('stops unavailable send reconciliation after several reads without resending',async () => {
    const f=await fixture();
    vi.mocked(BotApi.prototype.send).mockRejectedValue(new BotError('telegram_outcome_unknown','unknown'));
    expect(await delivery.sendPrepared(f.pub,new BotApi(),settings)).toBeNull();
    const reader=vi.fn().mockRejectedValue(new Error('read unavailable'));
    for(let attempt=1;attempt<=settings.requestMaxAttempts;attempt++) {
      expect(await delivery.reconcile(await publication(f.id),settings,reader)).toBe(false);
    }
    expect(await delivery.reconcile(await publication(f.id),settings,reader)).toBe(false);
    expect(reader).toHaveBeenCalledTimes(settings.requestMaxAttempts);
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT status,error_code,next_retry_at FROM publications WHERE id=$1',[f.id])).rows)
      .toEqual([{status:'uncertain',error_code:'send_not_found_requires_review',next_retry_at:null}]);
  });

});
