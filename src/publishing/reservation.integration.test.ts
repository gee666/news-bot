import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { Publication } from './store.js';
import type { AppSettings } from '../settings.js';
const media=vi.hoisted(() => ({ publicationMedia:vi.fn(),releaseStoryMedia:vi.fn().mockResolvedValue(undefined) }));
vi.mock('../media/story-media.js', () => media);
const url=process.env.TEST_DATABASE_URL;
const schema=`reservations_${randomUUID().replaceAll('-','')}`;
let admin:pg.Pool;
let database:typeof import('../db.js');
let store:typeof import('./store.js');
let delivery:typeof import('./delivery.js');
let order:typeof import('./destination-order.js');
let digest:typeof import('./digest.js');
let settings:AppSettings;
let api:BotApi;
async function load(id:string):Promise<Publication> {
  const row=(await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if(!row) throw new Error('Missing publication'); return row;
}
async function fixture() {
  const story=(await database.db.query<{id:string}>(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','News','Full text',8,true,false,$1,$2) RETURNING id`,[settings.profileVersion,settings.modelVersion])).rows[0]?.id;
  if(!story) throw new Error('Missing story');
  await acceptFixtureStories(settings,[story]);
  const [id]=await store.prepareDigest(settings,'-100123',{storyIds:[story]});
  if(!id) throw new Error('Missing prepared publication'); return load(id);
}

describe.skipIf(!url)('terminal publication reservation release', () => {
  beforeAll(async () => {
    admin=new pg.Pool({connectionString:url}); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped=new URL(url??''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database=await import('../db.js'); await database.migrate();
    store=await import('./store.js'); delivery=await import('./delivery.js');
    order=await import('./destination-order.js'); digest=await import('./digest.js');
  },60_000);
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings=await (await import('../settings.js')).saveSettings({publishingEnabled:true});
    await store.saveState('telegram_destination',{channelId:'-100123'});
    await store.saveState('bot_verified',{verified:true,destinationId:'-100123',botId:123});
    media.publicationMedia.mockReset().mockResolvedValue([{type:'image',mimeType:'image/png',data:Buffer.from('png')}]);
    api=new BotApi('123:synthetic');
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({id:123,is_bot:true});
    vi.spyOn(BotApi.prototype,'sendMedia').mockResolvedValue(['100']);
    vi.spyOn(BotApi.prototype,'send').mockResolvedValue('900');
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks(); if(database) await database.db.end();
    if(admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('releases permanent canonical rejection without resending either media or text', async () => {
    const owner=await fixture(); const other=await fixture();
    vi.mocked(api.send).mockRejectedValueOnce(new BotError('telegram_rejected','failed')).mockResolvedValue('901');
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await load(owner.id)).toMatchObject({status:'failed',message_id:null,media_status:'complete',error_code:'telegram_rejected'});
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await delivery.sendPrepared(other,api,settings)).toBe('901');
    expect(api.sendMedia).toHaveBeenCalledTimes(2); expect(api.send).toHaveBeenCalledTimes(2);
  });
  it.each(['stale','failed_story'] as const)('stops remaining batches and releases after %s admission denial', async change => {
    // Two compatible groups let the admission guard refuse the second upload.
    media.publicationMedia.mockResolvedValue([{type:'image',mimeType:'image/png',data:Buffer.from('png')},
      {type:'video',mimeType:'video/webm',data:Buffer.from('webm')}]);
    const owner=await fixture(); const other=await fixture();
    vi.mocked(api.sendMedia).mockImplementationOnce(async () => {
      if(change==='stale') await database.db.query('UPDATE stories SET content_version=content_version+1 WHERE id=$1',[owner.story_id]);
      else await database.db.query("UPDATE stories SET status='failed' WHERE id=$1",[owner.story_id]);
      return ['100'];
    });
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await load(owner.id)).toMatchObject({status:'failed',message_id:null,media_status:'failed'});
    expect((await database.db.query('SELECT status FROM publication_media_batches WHERE publication_id=$1 ORDER BY batch_number',[owner.id])).rows)
      .toEqual([{status:'sent'},{status:'failed'}]);
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(api.send).not.toHaveBeenCalled(); expect(api.sendMedia).toHaveBeenCalledOnce();
    expect(await delivery.sendPrepared(await load(owner.id),api,settings)).toBeNull();
    expect(await delivery.sendPrepared(other,api,settings)).toBe('900');
    expect(api.sendMedia).toHaveBeenCalledTimes(3); expect(api.send).toHaveBeenCalledOnce();
  });
  it.each(['missing','review_error'] as const)('unblocks news after unknown text is stopped for %s, without inventing or resending receipts', async outcome => {
    const owner=await fixture(); const other=await fixture();
    vi.mocked(api.send).mockRejectedValueOnce(new BotError('telegram_text_unknown','unknown')).mockResolvedValue('901');
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await order.reservedPublication('-100123')).toBeNull();
    const reader=async () => {
      if(outcome==='review_error') {
        const { ReconciliationReviewError }=await import('./reconciliation.js');
        throw new ReconciliationReviewError('Ambiguous channel match');
      }
      return null;
    };
    expect(await delivery.reconcile(await load(owner.id),settings,reader)).toBe(false);
    expect(await load(owner.id)).toMatchObject({status:'uncertain',message_id:null,error_code:'send_not_found_requires_review'});
    expect((await database.db.query("SELECT status FROM request_attempts WHERE publication_id=$1 AND operation='send'",[owner.id])).rows)
      .toEqual([{status:'unknown'}]);
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await delivery.sendPrepared(other,api,settings)).toBe('901');
    await digest.resumePublications(settings);
    expect(api.sendMedia).toHaveBeenCalledTimes(2); expect(api.send).toHaveBeenCalledTimes(2);
  });
  it('releases unknown text immediately and lets unrelated news proceed even while reconciliation is unavailable', async () => {
    const owner=await fixture(); const other=await fixture();
    vi.mocked(api.send).mockRejectedValueOnce(new BotError('telegram_text_unknown','unknown')).mockResolvedValue('901');
    await delivery.sendPrepared(owner,api,settings);
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(await delivery.reconcile(await load(owner.id),settings,async () => {throw new Error('Reader offline');})).toBe(false);
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(await load(owner.id)).toMatchObject({status:'uncertain',message_id:null,error_code:'reconciliation_unavailable'});
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await delivery.sendPrepared(other,api,settings)).toBe('901');
    expect(api.send).toHaveBeenCalledTimes(2);
  });
  it.each(['failed','review','published'] as const)('recovers an older process reservation already stopped as %s', async terminal => {
    const owner=await fixture();
    vi.mocked(api.send).mockRejectedValue(new BotError('telegram_rate_limit','retryable',120_000));
    await delivery.sendPrepared(owner,api,settings);
    if(terminal==='failed') await database.db.query("UPDATE publications SET status='failed',error_code='telegram_rejected' WHERE id=$1",[owner.id]);
    if(terminal==='review') await database.db.query("UPDATE publications SET status='uncertain',error_code='send_not_found_requires_review' WHERE id=$1",[owner.id]);
    if(terminal==='published') await database.db.query("UPDATE publications SET status='published',message_id='950' WHERE id=$1",[owner.id]);
    expect(await order.recoverDestination('-100123')).toBeNull();
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(api.sendMedia).toHaveBeenCalledOnce(); expect(api.send).toHaveBeenCalledOnce();
  });
});
