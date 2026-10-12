import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ modelStarted: false, refresh: vi.fn() }));
vi.mock('./stories.js', () => ({ refreshDigest: mocks.refresh }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./consolidation.js', () => ({ consolidateStories: vi.fn() }));
vi.mock('./source-links.js', () => ({ associateSourceLinks: vi.fn(), SOURCE_MESSAGES_PER_PASS: 50 }));
const url = process.env.TEST_DATABASE_URL;
const schema = `digest_contention_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let publicationId: string;
let snapshotId: string;
const content = { headline: 'Архив', details: 'Опубликованная версия', detailsKind: 'summary', score: 3, sources: [] };
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
describe.skipIf(!url)('digest history lock contention with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public -c lock_timeout=1500`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
    const story = await one("INSERT INTO stories(status,interest_stale) VALUES('failed',true) RETURNING id");
    snapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [story, JSON.stringify(content)]);
    const desired = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [story, JSON.stringify({ ...content, headline: 'Непроверенная правка' })]);
    publicationId = await one(`INSERT INTO publications(story_id,snapshot_id,pending_snapshot_id,destination_id,message_id,status)
      VALUES($1,$2,$3,'-100123','1','published') RETURNING id`, [story, snapshotId, desired]);
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('does not hold a session history lease across model work or publisher preparation on another client', async () => {
    const blocker = await database.db.connect();
    const { createPipeline } = await import('./index.js');
    const { prepareUpdates } = await import('../publishing/updates.js');
    let releaseModel: () => void = () => {};
    let modelStarted: () => void = () => {};
    const started = new Promise<void>(resolve => { modelStarted = resolve; });
    const resume = new Promise<void>(resolve => { releaseModel = resolve; });
    mocks.refresh.mockImplementation(async () => {
      mocks.modelStarted = true; modelStarted(); await resume;
      await prepareUpdates(settings, '-100123'); // Separate transaction client takes the same history key.
      return { completedStories: 0, failedStories: 1, skippedStories: 1 };
    });
    await blocker.query("SELECT pg_advisory_lock(hashtext('news-bot-history'))");
    const work = (await createPipeline()).runDigest();
    try {
      // External snapshot work may hold history, but that must not prevent the model phase from starting.
      await Promise.race([started, work.then(() => { throw new Error('Refresh skipped behind a long history lease'); })]);
      expect(mocks.modelStarted).toBe(true);
      await blocker.query("SELECT pg_advisory_unlock(hashtext('news-bot-history'))");
      releaseModel(); await work;
    } finally {
      releaseModel(); await blocker.query("SELECT pg_advisory_unlock(hashtext('news-bot-history'))"); blocker.release();
      await work.catch(() => {});
    }
    expect((await database.db.query('SELECT status,snapshot_id,pending_snapshot_id FROM publications WHERE id=$1', [publicationId])).rows[0])
      .toEqual({ status: 'published', snapshot_id: snapshotId, pending_snapshot_id: null });
    expect((await database.db.query('SELECT content FROM publication_snapshots WHERE id=$1', [snapshotId])).rows[0]?.content).toEqual(content);
    expect((await database.db.query("SELECT value FROM operational_state WHERE key='pipeline_digest'")).rows[0]?.value)
      .toMatchObject({ phase: 'completed', failedStories: 1 });
  });
});
