import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError, mediaUploadType } from './bot-api.js';
import { renderCaption } from './caption.js';
import { render } from './render.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { Publication } from './store.js';
import type { AppSettings } from '../settings.js';

const media = vi.hoisted(() => ({ publicationMedia: vi.fn(), releaseStoryMedia: vi.fn() }));
vi.mock('../media/story-media.js', () => media);
const url = process.env.TEST_DATABASE_URL;
const schema = `album_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let delivery: typeof import('./delivery.js');
let albums: typeof import('./album-delivery.js');
let plans: typeof import('./media-plan.js');
let attachments: typeof import('./media-delivery.js');
let settings: AppSettings;
let api: BotApi;
const image = (index: number) => ({ type: 'image' as const, mimeType: 'image/png', data: Buffer.from(`original PNG ${index}`) });
const ids = (count: number) => Array.from({ length: count }, (_, index) => String(100 + index));
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Fixture row missing');
  return row.id;
}
async function load(id: string): Promise<Publication> {
  const row = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`, [id])).rows[0];
  if (!row) throw new Error('Fixture publication missing');
  return row;
}
async function fixture(legacyAlbum = true): Promise<Publication> {
  const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','Album news',$1,8,true,false,$2,$3) RETURNING id`, ['Core facts 😀 '.repeat(200), settings.profileVersion, settings.modelVersion]);
  await acceptFixtureStories(settings, [storyId]);
  const [id] = await store.prepareDigest(settings, '-100123', { storyIds: [storyId] });
  if (!id) throw new Error('Prepared fixture missing');
  if (legacyAlbum) await plans.preparePublicationMedia(await load(id), settings, true);
  return load(id);
}
async function tracked() {
  return (await database.db.query<{ message_id: string | null; data: Buffer | null; deleted_at: Date | null }>(
    'SELECT message_id,data,deleted_at FROM publication_media_items ORDER BY ordinal')).rows;
}

// Disposable schemas and synthetic bytes only. No Telegram, model or download calls.
describe.skipIf(!url)('legacy caption-first album PostgreSQL lifecycle', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:synthetic');
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js'); delivery = await import('./delivery.js'); albums = await import('./album-delivery.js');
    plans = await import('./media-plan.js'); attachments = await import('./media-delivery.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    await store.saveState('telegram_destination', { channelId: '-100123' });
    api = new BotApi('123:synthetic');
    vi.spyOn(api, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.spyOn(api, 'send').mockRejectedValue(new Error('Unexpected text send'));
    vi.spyOn(api, 'sendMedia').mockRejectedValue(new Error('Unexpected legacy attachment send'));
    vi.spyOn(api, 'edit').mockRejectedValue(new Error('Unexpected text edit'));
    media.publicationMedia.mockReset().mockResolvedValue([image(0), image(1)]);
    media.releaseStoryMedia.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it.each([1, 10])('publishes %i candidates as one bounded original-byte request and atomically commits every ID', async count => {
    const original = Array.from({ length: count }, (_, index) => image(index));
    media.publicationMedia.mockResolvedValue(original);
    const publication = await fixture();
    const send = vi.spyOn(api, 'sendAlbum').mockImplementation(async (_destination, caption, selected) => {
      expect((await load(publication.id))).toMatchObject({ status: 'sending', delivery_kind: 'album', message_id: null });
      expect((await database.db.query('SELECT status FROM request_attempts')).rows).toEqual([{ status: 'running' }]);
      expect((await database.db.query('SELECT status FROM publication_media_batches')).rows).toEqual([{ status: 'running' }]);
      expect(caption.plainText.length).toBeLessThanOrEqual(1024);
      expect(selected).toEqual(original.slice(0, 10));
      expect((await tracked()).map(item => item.data)).toEqual(original.slice(0, 10).map(item => item.data));
      return ids(selected.length);
    });
    expect(await delivery.sendPrepared(publication, api, settings)).toBe('100');
    expect(send).toHaveBeenCalledOnce(); expect(api.send).not.toHaveBeenCalled(); expect(api.sendMedia).not.toHaveBeenCalled();
    expect(await load(publication.id)).toMatchObject({ status: 'published', delivery_kind: 'album', message_id: '100', media_status: 'complete', content: publication.content });
    expect((await tracked()).map(item => [item.message_id, item.data])).toEqual(ids(Math.min(count, 10)).map(id => [id, null]));
    await attachments.retryPublicationMedia(api, settings, '-100123');
    expect(send).toHaveBeenCalledOnce(); expect(api.sendMedia).not.toHaveBeenCalled();
  });

  it('keeps text-only publications on the original send/edit lifecycle', async () => {
    media.publicationMedia.mockResolvedValue([]);
    const publication = await fixture(false); vi.mocked(api.send).mockResolvedValue('50');
    const album = vi.spyOn(api, 'sendAlbum');
    expect(await delivery.sendPrepared(publication, api, settings)).toBe('50');
    expect(api.send).toHaveBeenCalledOnce(); expect(album).not.toHaveBeenCalled();
    expect(await load(publication.id)).toMatchObject({ delivery_kind: 'text', media_status: 'none' });
  });

  it('authorizes at most one concurrent send and refuses an exact-plan swap or expiry before authorization', async () => {
    const publication = await fixture();
    const send = vi.spyOn(api, 'sendAlbum').mockResolvedValue(ids(2));
    await Promise.all([delivery.sendPrepared(publication, api, settings), delivery.sendPrepared(publication, api, settings)]);
    expect(send).toHaveBeenCalledOnce();
    for (const change of ['id=gen_random_uuid()', "expires_at=now()-interval '1 second'"]) {
      const next = await fixture();
      vi.mocked(api.identity).mockImplementationOnce(async () => {
        await database.db.query(`UPDATE publication_media_items SET ${change} WHERE batch_id IN
          (SELECT id FROM publication_media_batches WHERE publication_id=$1)`, [next.id]);
        return { id: 123, is_bot: true };
      });
      expect(await delivery.sendPrepared(next, api, settings)).toBeNull();
    }
    expect(send).toHaveBeenCalledOnce();
  });

  it('keeps unknown outcomes unsafe across restart and requires every reconciled ID', async () => {
    const publication = await fixture();
    const send = vi.spyOn(api, 'sendAlbum').mockRejectedValue(new BotError('telegram_transport_unknown', 'unknown'));
    expect(await delivery.sendPrepared(publication, api, settings)).toBeNull();
    expect(await load(publication.id)).toMatchObject({ status: 'uncertain', media_status: 'unknown', message_id: null });
    await (await import('./digest.js')).recoverSends('-100123'); await plans.recoverPublicationMedia('-100123');
    expect(await delivery.sendPrepared(await load(publication.id), api, settings)).toBeNull();
    expect(await delivery.reconcile(await load(publication.id), settings, async () => '100')).toBe(false);
    expect(await delivery.reconcile(await load(publication.id), settings, async () => ({ messageId: '100', messageIds: ['100'] }))).toBe(false);
    expect((await tracked()).every(item => item.data !== null && item.message_id === null)).toBe(true);
    expect(await delivery.reconcile(await load(publication.id), settings, async () => ({ messageId: '100', messageIds: ids(2) }))).toBe(true);
    expect((await tracked()).map(item => item.message_id)).toEqual(ids(2));
    await attachments.retryPublicationMedia(api, settings, '-100123');
    expect(send).toHaveBeenCalledOnce(); expect(api.sendMedia).not.toHaveBeenCalled();
  });

  it('keeps a proven pre-request connection failure retryable across recovery', async () => {
    const publication = await fixture();
    const send = vi.spyOn(api, 'sendAlbum').mockRejectedValueOnce(new BotError('telegram_connect_failed', 'retryable')).mockResolvedValue(ids(2));
    expect(await delivery.sendPrepared(publication, api, settings)).toBeNull();
    expect(await load(publication.id)).toMatchObject({ status: 'prepared', media_status: 'pending' });
    await (await import('./digest.js')).recoverSends('-100123');
    await plans.recoverPublicationMedia('-100123');
    expect(await load(publication.id)).toMatchObject({ status: 'prepared' });
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_media_batches SET next_retry_at=now()-interval '1 second'");
    expect(await delivery.sendPrepared(await load(publication.id), api, settings)).toBe('100');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries an explicit 429 only after cooldown using the frozen original bytes', async () => {
    const publication = await fixture();
    const send = vi.spyOn(api, 'sendAlbum').mockRejectedValueOnce(new BotError('telegram_rate_limit', 'retryable', 120_000)).mockResolvedValue(ids(2));
    expect(await delivery.sendPrepared(publication, api, settings)).toBeNull();
    expect(await store.rateLimited()).toBe(true);
    expect(await delivery.sendPrepared(await load(publication.id), api, settings)).toBeNull();
    media.publicationMedia.mockResolvedValue([image(99)]);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_media_batches SET next_retry_at=now()-interval '1 second'");
    expect(await delivery.sendPrepared(await load(publication.id), api, settings)).toBe('100');
    expect(media.publicationMedia).toHaveBeenCalledOnce();
    expect(send.mock.calls[1]?.[2]).toEqual([image(0), image(1)]);
    expect(send).toHaveBeenCalledTimes(2); expect(api.send).not.toHaveBeenCalled(); expect(api.sendMedia).not.toHaveBeenCalled();
  });

  it('treats expired spool bytes and permanent Telegram rejection as terminal instead of retrying preparation forever', async () => {
    let publication = await fixture(); await plans.preparePublicationMedia(publication, settings, true); publication = await load(publication.id);
    await database.db.query("UPDATE publication_media_items SET expires_at=now()-interval '1 second'");
    const send = vi.spyOn(api, 'sendAlbum');
    expect(await delivery.sendPrepared(publication, api, settings)).toBeNull();
    expect(await load(publication.id)).toMatchObject({ status: 'failed', next_retry_at: null });
    expect(send).not.toHaveBeenCalled();
    const rejected = await fixture(); send.mockRejectedValue(new BotError('telegram_rejected_403', 'failed'));
    expect(await delivery.sendPrepared(rejected, api, settings)).toBeNull();
    expect(await load(rejected.id)).toMatchObject({ status: 'failed', media_status: 'failed', next_retry_at: null });
    expect(await delivery.sendPrepared(await load(rejected.id), api, settings)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    await plans.expirePublicationMedia();
  });

  it('rolls back all success records after a post-send database error without authorizing a resend', async () => {
    const publication = await fixture(); const send = vi.spyOn(api, 'sendAlbum').mockResolvedValue(ids(2));
    await database.db.query(`CREATE FUNCTION reject_album_completion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic commit failure'; END $$`);
    await database.db.query(`CREATE TRIGGER reject_album_completion BEFORE UPDATE ON publications
      FOR EACH ROW WHEN (NEW.status='published') EXECUTE FUNCTION reject_album_completion()`);
    try { expect(await delivery.sendPrepared(publication, api, settings)).toBeNull(); }
    finally { await database.db.query('DROP TRIGGER reject_album_completion ON publications'); await database.db.query('DROP FUNCTION reject_album_completion()'); }
    expect(await load(publication.id)).toMatchObject({ status: 'uncertain', media_status: 'unknown', message_id: null });
    expect((await tracked()).every(item => item.data !== null && item.message_id === null)).toBe(true);
    expect(await delivery.sendPrepared(await load(publication.id), api, settings)).toBeNull(); expect(send).toHaveBeenCalledOnce();
  });

  it('recovers a process interrupted after authorization as unknown, never as a fresh send', async () => {
    let publication = await fixture(); await plans.preparePublicationMedia(publication, settings, true); publication = await load(publication.id);
    const plan = await albums.readAlbumPlan(publication);
    const { sendMetadata } = await import('./reconciliation.js');
    expect(await delivery.beginAttempt(publication, 'send', { ...sendMetadata(renderCaption(publication.content)), deliveryKind: 'album', botId: '123',
      itemIds: plan.items.map(item => item.id), uploadTypes: plan.media.map(mediaUploadType) }, settings)).not.toBeNull();
    await (await import('./digest.js')).recoverSends('-100123'); await plans.recoverPublicationMedia('-100123');
    expect(await load(publication.id)).toMatchObject({ status: 'uncertain', media_status: 'unknown' });
    const send = vi.spyOn(api, 'sendAlbum'); expect(await delivery.sendPrepared(await load(publication.id), api, settings)).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('edits only the caption and reconciles an unknown edit using its bounded fingerprint', async () => {
    const publication = await fixture(); vi.spyOn(api, 'sendAlbum').mockResolvedValue(ids(2));
    await delivery.sendPrepared(publication, api, settings); const sent = await load(publication.id);
    const edit = vi.spyOn(api, 'editCaption').mockRejectedValue(new BotError('telegram_transport_unknown', 'unknown'));
    expect(await delivery.editPublication(sent, api, settings)).toBe(false);
    expect(edit).toHaveBeenCalledOnce(); expect(api.edit).not.toHaveBeenCalled();
    expect(edit.mock.calls[0]?.[2].plainText.length).toBeLessThanOrEqual(1024);
    const { sendMetadata } = await import('./reconciliation.js');
    const expected = sendMetadata(renderCaption(sent.content)).fingerprint;
    expect(expected).not.toBe(sendMetadata(render(sent.content)).fingerprint);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second' WHERE operation='edit'");
    const { reconcileUnknownEdit } = await import('./edit-reconciliation.js');
    expect(await reconcileUnknownEdit(sent, async () => expected)).toBe(true);
    expect(edit).toHaveBeenCalledOnce();
    expect((await database.db.query("SELECT status FROM request_attempts WHERE operation='edit'")).rows).toEqual([{ status: 'succeeded' }]);
  });

  it('deletes siblings before the canonical caption exactly once and resumes durable partial progress', async () => {
    const publication = await fixture(); vi.spyOn(api, 'sendAlbum').mockResolvedValue(ids(2));
    await delivery.sendPrepared(publication, api, settings); const sent = await load(publication.id);
    const remove = vi.spyOn(api, 'delete').mockResolvedValueOnce(undefined).mockRejectedValueOnce(new BotError('telegram_rate_limit', 'retryable', 1000));
    await expect(attachments.deletePublicationMessages(sent, api)).rejects.toMatchObject({ outcome: 'retryable' });
    expect(remove.mock.calls.map(call => call[1])).toEqual(['101', '100']);
    expect((await tracked()).map(item => Boolean(item.deleted_at))).toEqual([false, true]);
    remove.mockResolvedValue(undefined); await attachments.deletePublicationMessages(sent, api);
    expect(remove.mock.calls.map(call => call[1])).toEqual(['101', '100', '100']);
    expect((await tracked()).every(item => item.deleted_at !== null)).toBe(true);
    await attachments.deletePublicationMessages(sent, api); expect(remove).toHaveBeenCalledTimes(3);
  });

  it('preserves migrated text/reply plans and their pending legacy attachment retries', async () => {
    let publication = await fixture(false); await plans.preparePublicationMedia(publication, settings); publication = await load(publication.id);
    expect(publication.delivery_kind).toBe('text');
    vi.mocked(api.send).mockResolvedValue('50'); vi.mocked(api.sendMedia).mockResolvedValue(ids(2));
    const album = vi.spyOn(api, 'sendAlbum');
    expect(await delivery.sendPrepared(publication, api, settings)).toBe('50');
    expect(album).not.toHaveBeenCalled(); expect(api.send).toHaveBeenCalledOnce(); expect(api.sendMedia).toHaveBeenCalledOnce();
    expect((await load(publication.id)).delivery_kind).toBe('text');
  });
});
