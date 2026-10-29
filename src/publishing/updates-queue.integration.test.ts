import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import type { PublicationSnapshot } from '../types.js';
import type { Publication } from './store.js';
import type { AppSettings } from '../settings.js';

const mocks = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock('./delivery.js', () => ({ editPublication: mocks.edit }));
const url = process.env.TEST_DATABASE_URL;
const schema = `edit_queue_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let updates: typeof import('./updates.js');
let defaultSettings: AppSettings;
const content: PublicationSnapshot = { headline: 'News', details: 'Facts', score: 8, detailsKind: 'summary', sources: [],
  updatedTo: 'https://t.me/c/123/1837' };

async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function publication(message: string, seconds: number) {
  const story = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  const sent = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [story, JSON.stringify(content)]);
  const pending = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [story, JSON.stringify(content)]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,pending_snapshot_id,destination_id,bot_id,status,message_id,created_at)
    VALUES($1,$2,$3,'-100123','123','published',$4,now()+$5*interval '1 second') RETURNING id`, [story, sent, pending, message, seconds]);
  return { id, sent, pending };
}

describe.skipIf(!url)('edit queue SQL admission before oldest-first limit', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); database = await import('../db.js'); await database.migrate();
    updates = await import('./updates.js');
    defaultSettings = (await import('../settings.js')).defaultSettings;
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden')));
    mocks.edit.mockReset().mockResolvedValue(true);
    await database.db.query('TRUNCATE publications,publication_snapshots,stories CASCADE');
    await database.db.query('DELETE FROM operational_state');
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  });

  it('a backed-off unknown edit cannot block a newer pending snapshot', async () => {
    const status = 'unknown';
    const older = await publication('4', -60); const newer = await publication('1063', 0);
    // The unresolved request can target a different snapshot from the pending one.
    const attempt = await one(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata,next_retry_at)
      VALUES($1,'telegram-bot','edit',1,$2,$3,now()+interval '1 hour') RETURNING id`,
    [older.id, status, JSON.stringify({ snapshotId: older.sent })]);
    const api = new BotApi('123:synthetic');
    expect(await updates.retryEdits(api, defaultSettings, '-100123')).toBe(1);
    expect(mocks.edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: newer.id }), api, defaultSettings);
    expect((await database.db.query('SELECT status FROM request_attempts WHERE id=$1', [attempt])).rows).toEqual([{ status }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retires an oldest edit owned by another bot instead of monopolizing the single slot',async () => {
    const older=await publication('928',-60); const newer=await publication('2076',0);
    await database.db.query("UPDATE publications SET bot_id='456' WHERE id=$1",[older.id]);
    expect(await updates.retryEdits(new BotApi('123:synthetic'),defaultSettings,'-100123')).toBe(0);
    expect((await database.db.query('SELECT pending_snapshot_id FROM publications WHERE id=$1',[older.id])).rows).toEqual([{pending_snapshot_id:null}]);
    expect(await updates.retryEdits(new BotApi('123:synthetic'),defaultSettings,'-100123')).toBe(1);
    expect(mocks.edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({id:newer.id}),expect.any(BotApi),defaultSettings);
  });
  it('settles expired sends and edits once without blocking fresh work or a newer snapshot', async () => {
    const older = await publication('4', -60);
    await database.db.query("INSERT INTO story_publication_threads(story_id,classification_version) SELECT story_id,'test' FROM publications WHERE id=$1", [older.id]);
    await database.db.query('UPDATE publications SET published_at=now() WHERE id=$1', [older.id]);
    const { desiredNavigation } = await import('./navigation.js');
    const prior = (await database.db.query<Publication>('SELECT * FROM publications WHERE id=$1', [older.id])).rows[0];
    if (!prior) throw new Error('Missing publication');
    const desired = await desiredNavigation(database.db, prior, content);
    await database.db.query("UPDATE publication_snapshots SET content=$2,created_at=now()-interval '5 hours' WHERE id=$1", [older.pending, JSON.stringify(desired)]);
    const attempt = await one(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata,dispatched_at,error_code,next_retry_at)
      VALUES($1,'telegram-bot','edit',1,'unknown',$2,now()-interval '5 hours','read_unconfirmed',now()+interval '1 day') RETURNING id`,
    [older.id, JSON.stringify({ snapshotId: older.pending })]);
    const unattempted = await publication('58', -50);
    await database.db.query("UPDATE publication_snapshots SET created_at=now()-interval '5 hours' WHERE id=$1", [unattempted.pending]);
    const sends = [];
    for (const status of ['unknown', 'retryable', 'running', null]) {
      const send = await publication(String(200 + sends.length), -40);
      sends.push(send.id);
      await database.db.query(`UPDATE publications SET status=$2,message_id=NULL,pending_snapshot_id=NULL,
        created_at=now()-interval '5 hours' WHERE id=$1`, [send.id, status === 'unknown' ? 'uncertain' : status === 'running' ? 'sending' : 'prepared']);
      if (status) await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,dispatched_at,next_retry_at)
        VALUES($1,'telegram-bot','send',1,$2,now()-interval '5 hours',now()+interval '1 day')`, [send.id, status]);
    }
    const freshSend = await publication('299', -30);
    await database.db.query(`UPDATE publications SET status='prepared',message_id=NULL,pending_snapshot_id=NULL,
      created_at=now()-interval '5 hours' WHERE id=$1`, [freshSend.id]);
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,dispatched_at)
      VALUES($1,'telegram-bot','send',1,'retryable',now()-interval '1 hour')`, [freshSend.id]);
    const fresh = await publication('1063', 0);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await import('./store.js');
    const send = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`, [sends[1]])).rows[0];
    if (!send) throw new Error('Missing expired send');
    const actual = await vi.importActual<typeof import('./delivery.js')>('./delivery.js');
    expect(await actual.sendPrepared(send, new BotApi('123:synthetic'), defaultSettings)).toBeNull();
    expect(await store.settleExpiredPublications('-100123')).toHaveLength(5);
    expect(await store.settleExpiredPublications('-100123')).toEqual([]);
    await (await import('./thread-updates.js')).prepareThreadUpdates('-100123');
    expect(warning).toHaveBeenCalledTimes(6);
    expect((await database.db.query('SELECT status FROM publications WHERE id=$1', [freshSend.id])).rows).toEqual([{ status: 'prepared' }]);
    expect(warning.mock.calls.some(([line]) => line.includes(`publication=${older.id} message=4 kind=edit last_error=read_unconfirmed`))).toBe(true);
    expect((await database.db.query('SELECT status,error_code,next_retry_at FROM request_attempts WHERE id=$1', [attempt])).rows)
      .toEqual([{ status: 'failed', error_code: 'publication_retry_window_expired', next_retry_at: null }]);
    expect((await database.db.query('SELECT pending_snapshot_id FROM publications WHERE id=ANY($1::uuid[])', [[older.id, unattempted.id]])).rows)
      .toEqual([{ pending_snapshot_id: null }, { pending_snapshot_id: null }]);
    expect((await database.db.query('SELECT status,error_code FROM publications WHERE id=ANY($1::uuid[])', [sends])).rows)
      .toEqual(sends.map(() => ({ status: 'failed', error_code: 'publication_retry_window_expired' })));
    mocks.edit.mockImplementation(async publication => {
      await database.db.query('UPDATE publications SET snapshot_id=pending_snapshot_id,pending_snapshot_id=NULL WHERE id=$1', [publication.id]);
      return true;
    });
    expect(await updates.retryEdits(new BotApi('123:synthetic'), defaultSettings, '-100123')).toBe(1);
    expect(mocks.edit.mock.calls[0]?.[0].id).toBe(fresh.id);
    const newer = await one('INSERT INTO publication_snapshots(story_id,content) SELECT story_id,$2 FROM publications WHERE id=$1 RETURNING id',
      [older.id, JSON.stringify({ ...content, updatedTo: 'https://t.me/c/123/1852' })]);
    await database.db.query('UPDATE publications SET pending_snapshot_id=$2 WHERE id=$1', [older.id, newer]);
    expect(await updates.retryEdits(new BotApi('123:synthetic'), defaultSettings, '-100123')).toBe(1);
    expect(mocks.edit.mock.calls[1]?.[0].id).toBe(older.id);
    expect((await database.db.query('SELECT snapshot_id,pending_snapshot_id FROM publications WHERE id=$1', [older.id])).rows)
      .toEqual([{ snapshot_id: newer, pending_snapshot_id: null }]);
    expect(warning).toHaveBeenCalledTimes(6);
    expect(fetch).not.toHaveBeenCalled();
  });

});
