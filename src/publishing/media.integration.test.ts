import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import type { Publication } from './store.js';
import type { AppSettings } from '../settings.js';

const media = vi.hoisted(() => ({ publicationMedia: vi.fn(), releaseStoryMedia: vi.fn() }));
vi.mock('../media/story-media.js', () => media);
const url = process.env.TEST_DATABASE_URL;
const schema = `publication_media_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let plan: typeof import('./media-plan.js');
let delivery: typeof import('./media-delivery.js');
let store: typeof import('./store.js');
let settings: AppSettings;
let api: BotApi;

async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Fixture row missing');
  return row.id;
}
async function fixture(): Promise<Publication> {
  const storyId = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  const snapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
    [storyId, JSON.stringify({ headline: 'News', details: 'Full text', score: 7, detailsKind: 'summary', sources: [] })]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id) VALUES($1,$2,'-100123','123') RETURNING id`,
    [storyId, snapshotId]);
  return load(id);
}
async function load(id: string): Promise<Publication> {
  const row = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`, [id])).rows[0];
  if (!row) throw new Error('Fixture publication missing');
  return row;
}
async function sent(publication: Publication): Promise<Publication> {
  await database.db.query("UPDATE publications SET status='published',message_id='9' WHERE id=$1", [publication.id]);
  return load(publication.id);
}

// This suite never downloads media, calls models, or reaches Telegram.
describe.skipIf(!url)('publication media durable PostgreSQL delivery', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? '');
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js');
    await database.migrate();
    plan = await import('./media-plan.js');
    delivery = await import('./media-delivery.js');
    store = await import('./store.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:synthetic');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    await store.saveState('telegram_destination', { channelId: '-100123' });
    api = new BotApi('123:synthetic');
    vi.spyOn(api, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    media.publicationMedia.mockReset().mockResolvedValue([
      { type: 'image', data: Buffer.from('image'), mimeType: 'image/jpeg' },
      { type: 'image', data: Buffer.from('image'), mimeType: 'image/jpeg' },
      { type: 'video', data: Buffer.from('video'), mimeType: 'video/mp4' },
    ]);
    media.releaseStoryMedia.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('spools deduplicated bytes before any request, erases them after upload and retains Telegram ids', async () => {
    let publication = await fixture();
    await plan.preparePublicationMedia(publication, settings);
    expect((await database.db.query('SELECT data FROM publication_media_items ORDER BY ordinal')).rows.map(row => row.data))
      .toEqual([Buffer.from('image'), Buffer.from('video')]);
    publication = await sent(publication);
    const upload = vi.spyOn(api, 'sendMedia').mockImplementation(async () => {
      expect((await database.db.query('SELECT status FROM publication_media_batches')).rows[0]?.status).toBe('running');
      return ['10', '11'];
    });
    expect(await delivery.deliverPublicationMedia(publication, api, settings)).toBe(true);
    expect(upload).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT data,message_id FROM publication_media_items ORDER BY ordinal')).rows)
      .toEqual([{ data: null, message_id: '10' }, { data: null, message_id: '11' }]);
    expect((await load(publication.id)).media_status).toBe('complete');
    expect(media.releaseStoryMedia).toHaveBeenCalledWith(publication.story_id);
  });

  it('expires week-old bytes even for unpublished and unknown attempts, without making unknown outcomes retryable', async () => {
    const unsent = await fixture();
    await plan.preparePublicationMedia(unsent, settings);
    const unknown = await fixture();
    await plan.preparePublicationMedia(unknown, settings);
    await sent(unknown);
    await database.db.query("UPDATE publication_media_batches SET status='unknown' WHERE publication_id=$1", [unknown.id]);
    await database.db.query("UPDATE publication_media_items SET expires_at=now()-interval '1 second'");
    await plan.expirePublicationMedia();
    expect((await database.db.query('SELECT data FROM publication_media_items')).rows.every(row => row.data === null)).toBe(true);
    expect((await load(unsent.id)).media_status).toBe('failed');
    expect((await load(unknown.id)).media_status).toBe('unknown');
    expect((await database.db.query('SELECT status FROM publication_media_batches WHERE publication_id=$1', [unknown.id])).rows[0]?.status).toBe('unknown');
  });

  it('never resends unknown uploads and refuses deletion with untracked outcomes', async () => {
    let publication = await fixture();
    await plan.preparePublicationMedia(publication, settings);
    publication = await sent(publication);
    const upload = vi.spyOn(api, 'sendMedia').mockRejectedValue(new BotError('telegram_transport_unknown', 'unknown'));
    expect(await delivery.deliverPublicationMedia(publication, api, settings)).toBe(false);
    await delivery.retryPublicationMedia(api, settings, '-100123');
    expect(await delivery.deliverPublicationMedia(await load(publication.id), api, settings)).toBe(false);
    expect(upload).toHaveBeenCalledOnce();
    expect((await load(publication.id)).media_status).toBe('unknown');
    const remove = vi.spyOn(api, 'delete');
    await expect(delivery.deletePublicationMedia(publication, api)).rejects.toMatchObject({ code: 'publication_media_requires_review' });
    expect(remove).not.toHaveBeenCalled();
  });

  it('retries rate limits without resending text, and survives later canonical text snapshot changes', async () => {
    let publication = await fixture();
    await plan.preparePublicationMedia(publication, settings);
    publication = await sent(publication);
    const upload = vi.spyOn(api, 'sendMedia').mockRejectedValueOnce(new BotError('telegram_rate_limit', 'retryable', 120_000))
      .mockResolvedValue(['10', '11']);
    expect(await delivery.deliverPublicationMedia(publication, api, settings)).toBe(false);
    expect(await store.rateLimited()).toBe(true);
    await delivery.retryPublicationMedia(api, settings, '-100123');
    expect(upload).toHaveBeenCalledOnce();
    const nextSnapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
      [publication.story_id, JSON.stringify({ headline: 'Edited text', details: 'Full edited text', score: 7, detailsKind: 'summary', sources: [] })]);
    await database.db.query('UPDATE publications SET snapshot_id=$2 WHERE id=$1', [publication.id, nextSnapshot]);
    await database.db.query("UPDATE publication_media_batches SET next_retry_at=now()-interval '1 second'");
    await delivery.retryPublicationMedia(api, settings, '-100123');
    expect(upload).toHaveBeenCalledTimes(2);
    expect((await load(publication.id)).media_status).toBe('complete');
  });

  it('finalizes an all-sent plan after a crash between the last batch commit and publication completion', async () => {
    let publication = await fixture();
    await plan.preparePublicationMedia(publication, settings);
    publication = await sent(publication);
    await database.db.query("UPDATE publication_media_batches SET status='sent'");
    await database.db.query("UPDATE publication_media_items SET data=NULL,message_id=(10+ordinal)::text");
    vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    const upload = vi.spyOn(BotApi.prototype, 'sendMedia');
    await store.saveState('bot_verified', { verified: true, destinationId: '-100123', botId: 123 });
    await (await import('./digest.js')).resumePublications(settings);
    expect((await load(publication.id)).media_status).toBe('complete');
    expect(upload).not.toHaveBeenCalled();
    expect(media.releaseStoryMedia).toHaveBeenCalledWith(publication.story_id);
  });

  it('preserves first-download expiry across delayed spooling and snapshot replanning', async () => {
    let publication = await fixture();
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    media.publicationMedia.mockResolvedValue([{ type: 'image', data: Buffer.from('image'), mimeType: 'image/jpeg', expiresAt: deadline }]);
    await plan.preparePublicationMedia(publication, settings);
    const expiry = async () => (await database.db.query<{ expires_at: Date }>('SELECT expires_at FROM publication_media_items')).rows[0]?.expires_at.getTime();
    expect(await expiry()).toBe(deadline);
    const nextSnapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
      [publication.story_id, JSON.stringify({ headline: 'Updated', details: 'Text', score: 7, detailsKind: 'summary', sources: [] })]);
    await database.db.query('UPDATE publications SET snapshot_id=$2 WHERE id=$1', [publication.id, nextSnapshot]);
    publication = await load(publication.id);
    media.publicationMedia.mockResolvedValue([{ type: 'image', data: Buffer.from('image'), mimeType: 'image/jpeg' }]);
    await plan.preparePublicationMedia(publication, settings);
    expect(await expiry()).toBe(deadline);
  });

  it('does not retry permanent rejection and converts an interrupted request to unknown after restart', async () => {
    let publication = await fixture();
    await plan.preparePublicationMedia(publication, settings);
    publication = await sent(publication);
    const upload = vi.spyOn(api, 'sendMedia').mockRejectedValue(new BotError('telegram_rejected_403', 'failed'));
    await delivery.deliverPublicationMedia(publication, api, settings);
    await delivery.retryPublicationMedia(api, settings, '-100123');
    expect(upload).toHaveBeenCalledOnce();
    expect((await load(publication.id)).media_status).toBe('failed');
    await database.db.query("UPDATE publication_media_batches SET status='running'");
    await plan.recoverPublicationMedia('-100123');
    expect((await load(publication.id)).media_status).toBe('unknown');
    expect((await database.db.query('SELECT status FROM publication_media_batches')).rows[0]?.status).toBe('unknown');
  });
});
