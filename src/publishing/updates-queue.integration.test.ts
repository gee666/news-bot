import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import type { AppSettings } from '../settings.js';

const mocks = vi.hoisted(() => ({ edit: vi.fn() }));
vi.mock('./delivery.js', () => ({ editPublication: mocks.edit }));
const url = process.env.TEST_DATABASE_URL;
const schema = `edit_queue_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let updates: typeof import('./updates.js');
let defaultSettings: AppSettings;
const content = { headline: 'News', details: 'Facts', score: 8, detailsKind: 'summary', sources: [],
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

  it.each(['unknown', 'running'])('a backed-off %s edit cannot block a newer pending snapshot', async status => {
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

  it('prioritizes a pending snapshot over an older due unknown, then backs off read-only reconciliation', async () => {
    const older = await publication('4', -60); const newer = await publication('1063', 0);
    const attempt = await one(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      VALUES($1,'telegram-bot','edit',1,'unknown',$2) RETURNING id`, [older.id, JSON.stringify({ snapshotId: older.pending })]);
    mocks.edit.mockImplementation(async publication => {
      if (publication.id === older.id) return false;
      await database.db.query('UPDATE publications SET snapshot_id=pending_snapshot_id,pending_snapshot_id=NULL WHERE id=$1', [publication.id]);
      return true;
    });
    const api = new BotApi('123:synthetic');
    expect(await updates.retryEdits(api, defaultSettings, '-100123')).toBe(1);
    expect(mocks.edit.mock.calls[0]?.[0].id).toBe(newer.id);
    expect(await updates.retryEdits(api, defaultSettings, '-100123')).toBe(0);
    expect(mocks.edit.mock.calls[1]?.[0].id).toBe(older.id);
    expect((await database.db.query(`SELECT status,next_retry_at>now() AS backed_off,
      (response_metadata->>'reconciliationAttempts')::int AS reconciliations FROM request_attempts WHERE id=$1`, [attempt])).rows)
      .toEqual([{ status: 'unknown', backed_off: true, reconciliations: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a permanently unconfirmable edit never delays new snapshots across passes and backs off from 30s to 6h', async () => {
    const older = await publication('4', -60);
    const attempt = await one(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      VALUES($1,'telegram-bot','edit',1,'unknown',$2) RETURNING id`, [older.id, JSON.stringify({ snapshotId: older.pending })]);
    mocks.edit.mockImplementation(async publication => {
      if (publication.id === older.id) return false;
      await database.db.query('UPDATE publications SET snapshot_id=pending_snapshot_id,pending_snapshot_id=NULL WHERE id=$1', [publication.id]);
      return true;
    });
    const api = new BotApi('123:synthetic');
    for (let pass = 0; pass < 12; pass++) {
      // Make the same old request due, as if a slow maintenance pass outlasted its backoff.
      await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second' WHERE id=$1", [attempt]);
      const newer = await publication(String(1063 + pass), pass);
      mocks.edit.mockClear();
      expect(await updates.retryEdits(api, defaultSettings, '-100123')).toBe(1);
      expect(mocks.edit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: newer.id }), api, defaultSettings);
      expect(await updates.retryEdits(api, defaultSettings, '-100123')).toBe(0);
      expect(mocks.edit.mock.calls[1]?.[0].id).toBe(older.id);
      const state = (await database.db.query<{ delay: number; reconciliations: number; status: string; attempt_number: number }>(`
        SELECT extract(epoch FROM(next_retry_at-now()))::float8 AS delay,
          (response_metadata->>'reconciliationAttempts')::int AS reconciliations,status,attempt_number
        FROM request_attempts WHERE id=$1`, [attempt])).rows[0];
      expect(state).toMatchObject({ status: 'unknown', attempt_number: 1, reconciliations: pass + 1 });
      const seconds = Math.min(21_600, 30 * 2 ** pass);
      expect(state?.delay).toBeGreaterThan(seconds - 2);
      expect(state?.delay).toBeLessThanOrEqual(seconds);
      // A second automatic tick before the deadline must not even try reconciliation.
      expect(await updates.retryEdits(api, defaultSettings, '-100123')).toBe(0);
      expect(mocks.edit).toHaveBeenCalledTimes(2);
    }
    expect((await database.db.query('SELECT count(*)::int AS n FROM request_attempts WHERE publication_id=$1', [older.id])).rows)
      .toEqual([{ n: 1 }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
