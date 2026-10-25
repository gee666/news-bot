import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError, type PublicationMedia } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { AppSettings } from '../settings.js';
import type { Publication } from './store.js';

const media = vi.hoisted(() => ({ publicationMedia: vi.fn(), releaseStoryMedia: vi.fn() }));
vi.mock('../media/story-media.js', () => media);
const url = process.env.TEST_DATABASE_URL;
const schema = `media_first_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let delivery: typeof import('./delivery.js');
let plans: typeof import('./media-plan.js');
let order: typeof import('./destination-order.js');
let digest: typeof import('./digest.js');
let settings: AppSettings;
let api: BotApi;
const image = (index: number): PublicationMedia => ({ type: 'image', mimeType: 'image/png', data: Buffer.from(`PNG ${index}`) });
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Fixture missing');
  return row.id;
}
async function load(id: string): Promise<Publication> {
  const row = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`, [id])).rows[0];
  if (!row) throw new Error('Publication missing');
  return row;
}
async function fixture(): Promise<Publication> {
  const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','Media-first news','Complete text with facts',8,true,false,$1,$2) RETURNING id`, [settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings,[storyId]);
  const [id] = await store.prepareDigest(settings,'-100123',{ storyIds:[storyId] });
  if (!id) throw new Error('Prepared fixture missing');
  return load(id);
}
async function due(): Promise<void> {
  await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
  await database.db.query("UPDATE publication_media_batches SET next_retry_at=now()-interval '1 second'");
  await database.db.query("UPDATE publications SET next_retry_at=now()-interval '1 second'");
  await database.db.query("UPDATE publication_text_parts SET next_retry_at=now()-interval '1 second'");
}
async function uploadIds(_destination: string, _reply: string | undefined, items: PublicationMedia[]): Promise<string[]> {
  return items.map((_,index) => String(100+index));
}

// Disposable PostgreSQL schemas, synthetic bytes, and no network/model requests.
describe.skipIf(!url)('durable media-first publication ordering', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString:url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js'); delivery = await import('./delivery.js'); plans = await import('./media-plan.js');
    order = await import('./destination-order.js'); digest = await import('./digest.js');
  },30_000);
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled:true });
    await store.saveState('telegram_destination',{ channelId:'-100123' });
    await store.saveState('bot_verified',{ verified:true,destinationId:'-100123',botId:123 });
    api = new BotApi('123:synthetic');
    vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id:123,is_bot:true });
    vi.spyOn(BotApi.prototype,'send').mockResolvedValue('900');
    vi.spyOn(BotApi.prototype,'sendMedia').mockImplementation(uploadIds);
    vi.spyOn(BotApi.prototype,'sendAlbum').mockRejectedValue(new Error('Legacy album forbidden for new posts'));
    media.publicationMedia.mockReset().mockResolvedValue([image(0),image(1)]);
    media.releaseStoryMedia.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('selects the first ten distinct combined images/videos, preserves bytes and finishes all compatible batches before text', async () => {
    const selected = Array.from({ length:12 },(_,index): PublicationMedia => index % 3 === 1
      ? { type:'video',mimeType:'video/webm',data:Buffer.from(`WEBM ${index}`) }
      : index % 3 === 2 ? { type:'video',mimeType:'video/mp4',data:Buffer.from(`MP4 ${index}`) } : image(index));
    media.publicationMedia.mockResolvedValue([selected[0],...selected]);
    const publication = await fixture();
    const uploaded: PublicationMedia[] = [];
    const events: string[] = [];
    vi.mocked(api.sendMedia).mockImplementation(async (target,reply,items) => {
      events.push('media'); expect(reply).toBeUndefined(); expect(target).toBe('-100123');
      expect(await order.reservedPublication(target)).toBe(publication.id);
      expect((await load(publication.id)).message_id).toBeNull();
      expect((await database.db.query('SELECT status FROM publication_text_parts')).rows).toEqual([{ status:'prepared' }]);
      const ids = items.map((_,index) => String(100+uploaded.length+index)); uploaded.push(...items); return ids;
    });
    vi.mocked(api.send).mockImplementation(async (_target,message,reply) => {
      events.push('text'); expect(reply).toBeUndefined(); expect(message.plainText).toContain('Complete text with facts');
      expect((await database.db.query('SELECT status FROM publication_media_batches')).rows.every(row => row.status === 'sent')).toBe(true);
      expect(await order.reservedPublication('-100123')).toBe(publication.id);
      return '900';
    });
    expect(await delivery.sendPrepared(publication,api,settings)).toBe('900');
    expect(uploaded).toEqual(selected.slice(0,10)); expect(events.at(-1)).toBe('text');
    expect(events.filter(event => event === 'text')).toHaveLength(1);
    expect(await load(publication.id)).toMatchObject({ delivery_kind:'media_first',message_id:'900',media_status:'complete',status:'published' });
    expect((await database.db.query('SELECT data,message_id FROM publication_media_items')).rows)
      .toEqual(Array.from({ length:10 },(_,index) => ({ data:null,message_id:String(100+index) })));
    expect(await order.reservedPublication('-100123')).toBeNull(); expect(api.sendAlbum).not.toHaveBeenCalled();
  });

  it('does not reserve a destination for zero media', async () => {
    media.publicationMedia.mockResolvedValue([]);
    const publication = await fixture();
    expect(await delivery.sendPrepared(publication,api,settings)).toBe('900');
    expect(api.sendMedia).not.toHaveBeenCalled(); expect(await order.reservedPublication('-100123')).toBeNull();
  });

  it.each(['unknown','failed'] as const)('retains the reservation after a %s media outcome and blocks every ancillary send path', async outcome => {
    const owner = await fixture(); const other = await fixture();
    vi.mocked(api.sendMedia).mockRejectedValue(new BotError('media_outcome',outcome));
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await order.reservedPublication('-100123')).toBe(owner.id);
    await digest.recoverSends('-100123'); await plans.recoverPublicationMedia('-100123');
    expect(await delivery.sendPrepared(await load(owner.id),api,settings)).toBeNull();
    expect(await delivery.sendPrepared(other,api,settings)).toBeNull();
    await database.db.query("UPDATE publications SET status='published',message_id='800' WHERE id=$1",[other.id]);
    const published = await load(other.id);
    await database.db.query(`INSERT INTO publication_text_parts(publication_id,part_number,snapshot_id,content)
      VALUES($1,1,$2,'{}')`,[other.id,other.snapshot_id]);
    expect(await (await import('./text-delivery.js')).deliverPublicationText(published,api,settings)).toBe(false);
    expect(await (await import('./media-delivery.js')).deliverPublicationMedia(published,api,settings)).toBe(false);
    await (await import('./navigation-delivery.js')).retryNavigationParts(api,settings,'-100123');
    expect(await (await import('./index.js')).verifyBot()).toMatchObject({ verified:false,messageId:null });
    await digest.publishDigest(settings);
    expect(api.sendMedia).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
    expect(await load(owner.id)).toMatchObject({ status:'prepared',message_id:null,media_status:outcome });
  });

  it('retries rejected media with the exact frozen bytes and snapshot, never adopts or refreshes it', async () => {
    const publication = await fixture();
    vi.mocked(api.sendMedia).mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000)).mockImplementation(uploadIds);
    expect(await delivery.sendPrepared(publication,api,settings)).toBeNull();
    const frozen = await load(publication.id);
    await digest.recoverSends('-100123'); await plans.recoverPublicationMedia('-100123'); await due();
    media.publicationMedia.mockResolvedValue([image(99)]);
    await store.refreshPrepared(frozen,settings); await store.adoptPreparedPublications(settings,'-100123');
    expect((await load(publication.id)).snapshot_id).toBe(frozen.snapshot_id);
    expect(await delivery.sendPrepared(await load(publication.id),api,settings)).toBe('900');
    expect(media.publicationMedia).toHaveBeenCalledOnce(); expect(api.sendMedia).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.sendMedia).mock.calls[1]?.[2]).toEqual([image(0),image(1)]);
  });

  it('resumes the destination owner before newly prepared stories after canonical rate limits, without uploading again', async () => {
    const owner = await fixture(); const other = await fixture();
    vi.mocked(api.send).mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000)).mockResolvedValue('900');
    expect(await delivery.sendPrepared(owner,api,settings)).toBeNull();
    expect(await order.reservedPublication('-100123')).toBe(owner.id);
    await due(); const events: string[] = [];
    vi.mocked(api.send).mockImplementation(async (_target,message) => { events.push(message.plainText); return events.length === 1 ? '900' : '901'; });
    await digest.resumePublications(settings);
    expect((await load(owner.id)).message_id).toBe('900'); expect((await load(other.id)).message_id).toBe('901');
    expect(api.sendMedia).toHaveBeenCalledTimes(2); // Once for each story, never twice for the owner.
    expect(await order.reservedPublication('-100123')).toBeNull();
  });

  it('never resends unknown canonical text, reconciles its text receipt only, and releases the destination atomically', async () => {
    const publication = await fixture(); const other = await fixture();
    vi.mocked(api.send).mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
    expect(await delivery.sendPrepared(publication,api,settings)).toBeNull();
    const uncertain = await load(publication.id);
    expect(uncertain).toMatchObject({ status:'uncertain',message_id:null,media_status:'complete' });
    expect(await delivery.sendPrepared(other,api,settings)).toBeNull();
    expect(await delivery.reconcile(uncertain,settings,async () => null)).toBe(false);
    expect(await order.reservedPublication('-100123')).toBe(publication.id);
    expect(await delivery.reconcile(uncertain,settings,async () => '950')).toBe(true);
    expect((await load(publication.id)).message_id).toBe('950');
    expect(await order.reservedPublication('-100123')).toBeNull(); expect(api.send).toHaveBeenCalledOnce();
    const attempts = (await database.db.query<{ operation:string; response_metadata:Record<string,unknown> }>(
      'SELECT operation,response_metadata FROM request_attempts ORDER BY dispatched_at')).rows;
    expect(attempts.find(attempt => attempt.operation === 'send')?.response_metadata).toMatchObject({ messageId:'950',reconciled:true,fingerprint:expect.any(String) });
    expect(attempts.find(attempt => attempt.operation.startsWith('send_media:'))?.response_metadata).not.toHaveProperty('fingerprint');
  });

  it('quarantines an interrupted media request on restart and keeps its destination blocked even after spool expiry', async () => {
    const publication = await fixture();
    vi.mocked(api.sendMedia).mockRejectedValue(new BotError('telegram_connect_failed','retryable'));
    await delivery.sendPrepared(publication,api,settings);
    await database.db.query("UPDATE publication_media_batches SET status='running'");
    await database.db.query("UPDATE request_attempts SET status='running'");
    await plans.recoverPublicationMedia('-100123'); await digest.recoverSends('-100123');
    await database.db.query("UPDATE publication_media_items SET expires_at=now()-interval '1 second'");
    await plans.expirePublicationMedia();
    expect((await load(publication.id)).media_status).toBe('unknown');
    expect((await database.db.query('SELECT status FROM request_attempts')).rows).toEqual([{ status:'unknown' }]);
    expect(await order.reservedPublication('-100123')).toBe(publication.id);
    await digest.resumePublications(settings); expect(api.sendMedia).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
  });

  it.each(['pause','destination','freshness'] as const)('checks %s again between media and canonical text without releasing ownership', async change => {
    const publication = await fixture();
    vi.mocked(api.sendMedia).mockImplementation(async (...args) => {
      if (change === 'pause') await (await import('../settings.js')).saveSettings({ publishingEnabled:false });
      else if (change === 'destination') await store.saveState('telegram_destination',{ channelId:'-100456' });
      else await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second'");
      return uploadIds(...args);
    });
    expect(await delivery.sendPrepared(publication,api,settings)).toBeNull();
    expect(api.sendMedia).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled();
    expect(await order.reservedPublication('-100123')).toBe(publication.id);
    expect((await load(publication.id)).message_id).toBeNull();
  });

  it('resumes after the last media commit but before canonical dispatch without uploading any media again', async () => {
    const publication = await fixture();
    vi.mocked(api.sendMedia).mockImplementation(async (...args) => {
      vi.mocked(api.identity).mockRejectedValueOnce(new Error('Process interrupted before text dispatch'));
      return uploadIds(...args);
    });
    await expect(delivery.sendPrepared(publication,api,settings)).rejects.toThrow('Process interrupted');
    expect(await load(publication.id)).toMatchObject({ status:'prepared',message_id:null,media_status:'complete' });
    expect(await order.reservedPublication('-100123')).toBe(publication.id);
    expect(api.send).not.toHaveBeenCalled();
    await digest.resumePublications(settings);
    expect((await load(publication.id)).message_id).toBe('900');
    expect(api.sendMedia).toHaveBeenCalledOnce(); expect(api.send).toHaveBeenCalledOnce();
    expect(await order.reservedPublication('-100123')).toBeNull();
  });

  it('releases a stale reservation on maintenance after final continuation commit with no other pending work', async () => {
    const original = await fixture();
    await database.db.query('UPDATE stories SET summary=$2 WHERE id=$1',[original.story_id,'Full factual paragraph. '.repeat(250)]);
    await acceptFixtureStories(settings); await store.refreshPrepared(original,settings);
    const publication = await load(original.id);
    vi.mocked(api.send).mockImplementation(async (_target,_message,reply) => {
      if (reply) {
        await database.db.query(`CREATE FUNCTION interrupt_release() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'Process interrupted before reservation release'; END $$;
          CREATE TRIGGER interrupt_release BEFORE DELETE ON publication_destination_reservations
          FOR EACH ROW EXECUTE FUNCTION interrupt_release()`);
      }
      return reply ? '901' : '900';
    });
    try {
      await expect(delivery.sendPrepared(publication,api,settings)).rejects.toThrow('Process interrupted');
    } finally {
      await database.db.query('DROP TRIGGER IF EXISTS interrupt_release ON publication_destination_reservations; DROP FUNCTION IF EXISTS interrupt_release()');
    }
    expect((await database.db.query('SELECT status FROM publication_text_parts')).rows.every(row => row.status === 'sent')).toBe(true);
    expect(await order.reservedPublication('-100123')).toBe(publication.id);
    const calls = vi.mocked(api.send).mock.calls.length;
    await digest.resumePublications(settings);
    expect(await order.reservedPublication('-100123')).toBeNull();
    expect(api.sendMedia).toHaveBeenCalledOnce(); expect(api.send).toHaveBeenCalledTimes(calls);
  });

  it.each(['retryable','unknown'] as const)('holds the destination through %s text continuations after the canonical receipt', async outcome => {
    const original = await fixture();
    await database.db.query('UPDATE stories SET summary=$2 WHERE id=$1',[original.story_id,'Full factual paragraph. '.repeat(250)]);
    await acceptFixtureStories(settings);
    await store.refreshPrepared(original,settings);
    const publication = await load(original.id);
    vi.mocked(api.send).mockImplementation(async (_target,_message,reply) => {
      if (reply) throw new BotError(outcome === 'retryable' ? 'telegram_rate_limit' : 'telegram_transport_unknown',outcome,120_000);
      return '900';
    });
    expect(await delivery.sendPrepared(publication,api,settings)).toBeNull();
    expect(await load(publication.id)).toMatchObject({ status:'published',message_id:'900' });
    expect(await order.reservedPublication('-100123')).toBe(publication.id);
    const calls = vi.mocked(api.send).mock.calls.length;
    await due(); vi.mocked(api.send).mockResolvedValue('901');
    await (await import('./text-delivery.js')).deliverPublicationText(await load(publication.id),api,settings);
    expect(vi.mocked(api.send).mock.calls.length).toBe(calls+(outcome === 'retryable' ? 1 : 0));
    expect(await order.reservedPublication('-100123')).toBe(outcome === 'retryable' ? null : publication.id);
    expect(api.sendMedia).toHaveBeenCalledOnce();
  });

  it('serializes a concurrent verification behind the whole pair using the existing digest lease', async () => {
    const publication = await fixture();
    let release: () => void = () => { throw new Error('Upload not started'); };
    let entered: () => void = () => { throw new Error('Upload observer missing'); };
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(api.sendMedia).mockImplementation(async (...args) => { entered(); await pending; return uploadIds(...args); });
    vi.mocked(api.send).mockResolvedValueOnce('900').mockResolvedValueOnce('901');
    vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
    const publishing = digest.publishDigest(settings);
    await started;
    let verified = false;
    const verifying = (await import('./index.js')).verifyBot().then(result => { verified = true; return result; });
    await new Promise(resolve => setTimeout(resolve,30));
    expect(verified).toBe(false); expect(api.send).not.toHaveBeenCalled();
    release(); await publishing;
    expect(await verifying).toMatchObject({ verified:true,messageId:'901' });
    expect((await load(publication.id)).message_id).toBe('900');
    expect(vi.mocked(api.send).mock.calls[0]?.[1].plainText).toContain('Complete text with facts');
    expect(vi.mocked(api.send).mock.calls[1]?.[1].plainText).toContain('Это технический тест');
  });

  it('keeps legacy attempted kinds and plans frozen even when their snapshot is version stamped', async () => {
    const publication = await fixture();
    await plans.preparePublicationMedia(publication,settings);
    await database.db.query("UPDATE publications SET delivery_kind='text' WHERE id=$1",[publication.id]);
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code)
      VALUES($1,'telegram-bot','send',1,'retryable','telegram_connect_failed')`,[publication.id]);
    media.publicationMedia.mockResolvedValue([image(99)]);
    expect(await plans.preparePublicationMedia(await load(publication.id),settings)).toBe(true);
    expect((await load(publication.id)).delivery_kind).toBe('text');
    expect(media.publicationMedia).toHaveBeenCalledOnce();
  });
});
