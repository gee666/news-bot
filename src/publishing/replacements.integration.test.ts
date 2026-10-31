import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { Publication } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `replacements_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let repair: typeof import('./repair.js');
let thread: typeof import('./thread-updates.js');
let settings: import('../settings.js').AppSettings;
let ordinal = 0;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql,values)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture'); return id;
}
async function fixture(status: Publication['status'] = 'published', destination = '-100123', bot = '123') {
  const n = ++ordinal;
  const story = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,'Confirmed facts',8,true,false,$2,$3) RETURNING id`, [`Edition ${n}`,settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings,[story]);
  const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
    [story,JSON.stringify({ headline:`Edition ${n}`,details:'Confirmed facts',score:8,detailsKind:'summary',sources:[] })]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id,status,message_id,published_at,format_version)
    VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5='published' THEN now()+$7::int*interval '1 second' ELSE NULL END,1) RETURNING id`,
    [story,snapshot,destination,bot,status,status==='published' ? String(100+n) : null,n]);
  return { id,story,snapshot,message:String(100+n) };
}
async function classify(a: string, b: string, relation: 'same' | 'related' = 'same') {
  await (await import('../pipeline/story-relations.js')).recordStoryRelations(a,[{storyId:b,relation}],'fixture',{origin:'user'});
}
async function pair(status: Publication['status'] = 'published') {
  const old = await fixture(); const latest = await fixture(status);
  await classify(old.story,latest.story); return { old,latest };
}
async function replacements() {
  return (await database.db.query<{ duplicate_publication_id: string; canonical_publication_id: string; status: string; error_code: string | null }>(
    'SELECT * FROM publication_replacements ORDER BY duplicate_publication_id')).rows;
}
const api = () => new BotApi('123:synthetic');

describe.skipIf(!url)('same-event replacement deletion outbox', () => {
  beforeAll(async () => {
    admin = new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString());
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js'); repair = await import('./repair.js'); thread = await import('./thread-updates.js');
    settings = await (await import('../settings.js')).saveSettings({publishingEnabled:true});
  });
  beforeEach(async () => {
    ordinal=0; vi.restoreAllMocks();
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({id:123,is_bot:true});
    vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
    vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new Error('Replacement must not edit old posts'));
    await database.db.query('TRUNCATE stories,publications,publication_snapshots,request_attempts CASCADE');
    await database.db.query("DELETE FROM operational_state WHERE key LIKE 'publication_%'");
    await store.saveState('telegram_destination',{channelId:'-100123'});
    await store.saveState('bot_verified',{verified:true,destinationId:'-100123',botId:123});
    settings = await (await import('../settings.js')).saveSettings({publishingEnabled:true});
  });
  afterAll(async () => {
    await database?.db.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('stages durable deletion instead of an UPD edit, deletes once, and retains the receipt as audit', async () => {
    const {old,latest} = await pair();
    await thread.prepareThreadUpdates('-100123');
    expect(await replacements()).toMatchObject([{duplicate_publication_id:old.id,canonical_publication_id:latest.id,status:'pending'}]);
    expect((await database.db.query('SELECT id FROM publications WHERE pending_snapshot_id IS NOT NULL')).rows).toEqual([]);
    expect(BotApi.prototype.delete).not.toHaveBeenCalled();
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(1);
    expect(BotApi.prototype.delete).toHaveBeenCalledExactlyOnceWith('-100123',old.message);
    expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect(await replacements()).toMatchObject([{status:'deleted'}]);
    expect((await database.db.query('SELECT status,message_id FROM publications WHERE id=$1',[old.id])).rows[0])
      .toEqual({status:'published',message_id:old.message});
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.delete).toHaveBeenCalledOnce();
  });
  it.each(['prepared','sending','uncertain','failed'] as const)('keeps the old post until a %s successor has a confirmed receipt', async status => {
    await pair(status); await thread.prepareThreadUpdates('-100123');
    expect(await replacements()).toEqual([]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.delete).not.toHaveBeenCalled();
  });
  it('does not replace related events, unclassified legacy threads, other destinations or other bots', async () => {
    const old=await fixture(); const related=await fixture(); await classify(old.story,related.story,'related');
    const legacy=await fixture();
    await database.db.query('INSERT INTO story_publication_threads(story_id,previous_story_id) VALUES($1,$2)',[legacy.story,old.story]);
    const elsewhere=await fixture('published','-100999'); await classify(old.story,elsewhere.story);
    const otherBot=await fixture('published','-100123','999'); await classify(old.story,otherBot.story);
    await thread.prepareThreadUpdates('-100123');
    expect(await replacements()).toEqual([]);
  });
  it('rechecks classification and current publishing permission at the attempt boundary', async () => {
    const {old,latest}=await pair(); await thread.prepareThreadUpdates('-100123');
    await classify(old.story,latest.story,'related');
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    await classify(old.story,latest.story);
    await (await import('../settings.js')).saveSettings({publishingEnabled:false});
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.delete).not.toHaveBeenCalled();
    expect((await database.db.query("SELECT * FROM request_attempts WHERE operation='delete'")).rows).toEqual([]);
  });
  it('preserves unknown old edits and does not delete until they are reconciled', async () => {
    const {old}=await pair();
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
      VALUES($1,'telegram-bot','edit',1,'unknown')`,[old.id]);
    await thread.prepareThreadUpdates('-100123'); expect(await replacements()).toEqual([]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    await database.db.query("UPDATE request_attempts SET status='succeeded'");
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(1);
  });
  it('backs off known rejections, retains bot cooldown and stops at the durable attempt budget', async () => {
    await pair(); vi.mocked(BotApi.prototype.delete).mockRejectedValue(new BotError('telegram_rate_limit','retryable',120000));
    for (let attempt=1;attempt<=settings.requestMaxAttempts;attempt++) {
      expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
      expect(BotApi.prototype.delete).toHaveBeenCalledTimes(attempt);
      expect(await store.rateLimited()).toBe(true);
      expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
      await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
      await database.db.query("UPDATE publication_replacements SET next_retry_at=now()-interval '1 second' WHERE status='pending'");
    }
    expect(await replacements()).toMatchObject([{status:'failed'}]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.delete).toHaveBeenCalledTimes(settings.requestMaxAttempts);
  });
  it.each(['unknown','crash'] as const)('never repeats a delete with an %s outcome, including after another edition', async outcome => {
    const {old,latest}=await pair(); await thread.prepareThreadUpdates('-100123');
    if (outcome==='unknown') {
      vi.mocked(BotApi.prototype.delete).mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
      expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    } else {
      const publication=(await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`,[old.id])).rows[0];
      if (!publication) throw new Error('Missing old post');
      expect(await (await import('./delivery.js')).beginAttempt(publication,'delete',{
        canonicalPublicationId:latest.id,canonicalSnapshotId:latest.snapshot},settings)).toBeTruthy();
    }
    const calls=vi.mocked(BotApi.prototype.delete).mock.calls.length;
    const newest=await fixture(); await classify(latest.story,newest.story);
    for (let tick=0;tick<2;tick++) await repair.retryReplacements(api(),settings,'-100123');
    expect(vi.mocked(BotApi.prototype.delete).mock.calls.filter(([,message])=>message===old.message)).toHaveLength(calls);
    expect((await replacements()).find(row=>row.duplicate_publication_id===old.id)?.status).toBe('failed');
  });
  it('retargets a pending deletion to the newest confirmed survivor without resetting attempts', async () => {
    const {old,latest}=await pair();
    vi.mocked(BotApi.prototype.delete).mockRejectedValueOnce(new BotError('telegram_connect_failed','retryable'));
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_replacements SET next_retry_at=now()-interval '1 second'");
    const newest=await fixture(); await classify(latest.story,newest.story);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(2);
    expect((await database.db.query("SELECT count(*)::int n FROM request_attempts WHERE publication_id=$1 AND operation='delete'",[old.id])).rows[0]?.n).toBe(2);
    expect((await replacements()).filter(row=>row.canonical_publication_id===newest.id)).toHaveLength(2);
    expect(BotApi.prototype.delete).toHaveBeenCalledWith('-100123',old.message);
    expect(BotApi.prototype.delete).toHaveBeenCalledWith('-100123',latest.message);
    expect(BotApi.prototype.delete).not.toHaveBeenCalledWith('-100123',newest.message);
  });
  it.each(['removed','stale','bot','destination','reserved'] as const)('keeps old posts when the confirmed survivor becomes %s', async reason => {
    const {latest}=await pair(); await thread.prepareThreadUpdates('-100123');
    if (reason==='removed') await store.saveState(`publication_removal:${latest.id}`,{reason:'fixture'});
    if (reason==='stale') await database.db.query('UPDATE stories SET content_version=content_version+1 WHERE id=$1',[latest.story]);
    if (reason==='bot') await store.saveState('bot_verified',{verified:true,destinationId:'-100123',botId:999});
    if (reason==='destination') await store.saveState('telegram_destination',{channelId:'-100999'});
    if (reason==='reserved') await database.db.query(`INSERT INTO publication_destination_reservations(destination_id,publication_id)
      VALUES('-100123',$1)`,[latest.id]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.delete).not.toHaveBeenCalled();
  });
  it('allows a confirmed canonical text to replace an old post despite unknown successor attachments', async () => {
    const {latest}=await pair();
    await database.db.query("UPDATE publications SET delivery_kind='media_first',media_status='unknown' WHERE id=$1",[latest.id]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(1);
  });
  it('refreshes the pinned proof after a confirmed canonical navigation edit', async () => {
    const {latest}=await pair(); await thread.prepareThreadUpdates('-100123');
    const snapshot=await one('INSERT INTO publication_snapshots(story_id,content) SELECT story_id,content FROM publication_snapshots WHERE id=$1 RETURNING id',[latest.snapshot]);
    await database.db.query('UPDATE publications SET snapshot_id=$2 WHERE id=$1',[latest.id,snapshot]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(1);
    expect((await database.db.query('SELECT canonical_snapshot_id FROM publication_replacements')).rows[0]?.canonical_snapshot_id).toBe(snapshot);
  });
  it('does not guess unknown media receipts when deleting an old post', async () => {
    const {old}=await pair();
    await database.db.query("UPDATE publications SET delivery_kind='media_first',media_status='unknown' WHERE id=$1",[old.id]);
    await database.db.query("INSERT INTO publication_media_batches(publication_id,batch_number,status) VALUES($1,0,'unknown')",[old.id]);
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.delete).not.toHaveBeenCalled();
    expect(await replacements()).toMatchObject([{status:'failed',error_code:'publication_media_requires_review'}]);
  });
  it('restricts manual replacement work to its selected canonical posts', async () => {
    const first=await pair(); const second=await pair();
    expect(await repair.retryReplacements(api(),settings,'-100123',[first.latest.id])).toBe(1);
    expect(BotApi.prototype.delete).not.toHaveBeenCalledWith('-100123',second.old.message);
  });
  it('deletes known media siblings before canonical text and does not repeat completed siblings', async () => {
    const {old}=await pair();
    await database.db.query("UPDATE publications SET delivery_kind='media_first',media_status='complete' WHERE id=$1",[old.id]);
    const batch=await one("INSERT INTO publication_media_batches(publication_id,batch_number,status) VALUES($1,0,'sent') RETURNING id",[old.id]);
    await database.db.query(`INSERT INTO publication_media_items(batch_id,ordinal,type,mime_type,digest,message_id,expires_at)
      VALUES($1,0,'image','image/png','fixture','500',now()+interval '1 day')`,[batch]);
    vi.mocked(BotApi.prototype.delete).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new BotError('telegram_connect_failed','retryable'));
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(0);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_replacements SET next_retry_at=now()-interval '1 second'");
    expect(await repair.retryReplacements(api(),settings,'-100123')).toBe(1);
    expect(vi.mocked(BotApi.prototype.delete).mock.calls.map(([,message])=>message)).toEqual(['500',old.message,old.message]);
  });
});
