import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { runNowProgressSchema } from './run-now-contract.js';
import type { RunNowJob } from './run-now.js';

const mocks = vi.hoisted(() => ({ article: vi.fn(), index: vi.fn(), collected: vi.fn(), extraction: vi.fn(), userClient: vi.fn() }));
vi.mock('../sources/collector.js', async importOriginal => ({ ...await importOriginal<typeof import('../sources/collector.js')>(),
  publisherReader: { index: mocks.index, article: mocks.article } }));
vi.mock('./collection.js', async importOriginal => ({ ...await importOriginal<typeof import('./collection.js')>(), collectBatch: mocks.collected }));
vi.mock('../telegram/client.js', () => ({ withUserClient: mocks.userClient }));
vi.mock('./extraction.js', () => ({ extractBatch: mocks.extraction }));
vi.mock('./matching.js', () => ({ matchBatch: vi.fn() }));
vi.mock('./revisions.js', () => ({ reconcileEdits: vi.fn() }));
vi.mock('./consolidation.js', () => ({ consolidateStories: vi.fn() }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./vectors.js', () => ({ Vectors: class { async close() {} } }));
const url = process.env.TEST_DATABASE_URL;
const schema = `run_now_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, args: unknown[] = []) {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
function job(mode: 'collect' | 'collected' = 'collect'): RunNowJob {
  return { id: randomUUID(), createdAt: new Date().toISOString(), runNow: runNowProgressSchema.parse({ stage: 'queued',
    options: { mode, sourceLimit: 2, inputLimit: 4, storyLimit: 2, publicationLimit: 1 } }) };
}
async function source(index: number) {
  return one(`INSERT INTO sources(connector_type,external_id,name,original_url,metadata)
    VALUES('feed',$1,$1,$1,$2) RETURNING id`, [`https://example.com/feed${index}`, JSON.stringify({ publisher: 'Example',
    articlePathPrefixes: ['/news/'], maxArticles: 5, unknownPublication: 'skip' })]);
}
async function pendingBatch(count: number) {
  const sourceId = await source(99);
  const batch = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,next_retry_at)
    VALUES('waiting',now(),$1,$2,$3,now()+interval '6 hours') RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
  const revisions: string[] = [];
  for (let index = 0; index < count; index++) {
    const item = await one('INSERT INTO source_items(source_id,external_id) VALUES($1,$2) RETURNING id', [sourceId, String(index)]);
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,1,$2,'New news','New news') RETURNING id`, [item, String(index)]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batch, revision]);
    revisions.push(revision);
  }
  return { batch, revisions };
}

describe.skipIf(!url)('bounded manual orchestration with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await database.db.query('TRUNCATE processing_batches,sources,stories,request_attempts CASCADE');
    await database.db.query("DELETE FROM operational_state WHERE key LIKE 'run_now_%'");
    mocks.userClient.mockRejectedValue(new Error('Live Telegram reads forbidden in tests'));
    mocks.index.mockResolvedValue(Array.from({ length: 30 }, (_, index) => ({ id: String(index),
      url: `https://example.com/news/${index}`, title: 'News', publishedAt: new Date(Date.now() - 1000) })));
    mocks.article.mockImplementation(async (url: string) => ({ access: 'public', canonicalUrl: url, title: 'News',
      content: 'New event with details.', publishedAt: new Date(Date.now() - 1000).toISOString(), metadata: {} }));
    mocks.extraction.mockImplementation(async (batchId: string, settings: AppSettings) => {
      const { stage } = await import('./state.js');
      const revisions = await database.db.query<{ revision_id: string }>('SELECT revision_id FROM batch_items WHERE batch_id=$1', [batchId]);
      for (const row of revisions.rows) await stage(batchId, { revisionId: row.revision_id }, 'manual_fixture', settings, z.boolean(), async () => true);
      await database.db.query("UPDATE batch_items SET status='rejected' WHERE batch_id=$1", [batchId]);
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks(); if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('bounds sources and actual article fetches, reports progress, and never calls broad collection', async () => {
    await Promise.all([source(1), source(2), source(3)]);
    const current = job(); const stages: string[] = [];
    const result = await (await import('./run-now.js')).runNow(current, async () => { stages.push(current.runNow?.stage ?? 'missing'); }, new AbortController().signal);
    expect(result.status).toBe('completed_with_errors');
    expect(stages).toEqual(expect.arrayContaining(['collecting', 'processing', 'publishing']));
    expect(current.runNow).toMatchObject({ stage: 'finished', sources: 2, inputs: 4, rejected: 4, published: 0 });
    expect(mocks.article).toHaveBeenCalledTimes(4); expect(mocks.index).toHaveBeenCalledTimes(2);
    expect(mocks.collected).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT count(*)::int AS count FROM batch_items WHERE batch_id=$1', [current.batchId])).rows[0]?.count).toBe(4);
    const cursors = (await database.db.query('SELECT collection_cursor FROM sources')).rows;
    expect(cursors.filter(row => Object.keys(row.collection_cursor).length > 0)).toHaveLength(2);
  });
  it('processes only never-dispatched fresh inputs despite a six-hour batch wait; retains the old deadline', async () => {
    const original = await pendingBatch(10);
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
      VALUES($1,$2,'count','waiting',now()+interval '6 hours')`, [original.batch, original.revisions[0]]);
    const deadline = (await database.db.query('SELECT next_retry_at FROM processing_batches WHERE id=$1', [original.batch])).rows[0]?.next_retry_at;
    const current = job('collected');
    await (await import('./run-now.js')).runNow(current, async () => {}, new AbortController().signal);
    expect(current.runNow?.inputs).toBe(4); expect(mocks.article).not.toHaveBeenCalled();
    const members = (await database.db.query('SELECT revision_id FROM batch_items WHERE batch_id=$1', [current.batchId])).rows;
    expect(members).not.toContainEqual({ revision_id: original.revisions[0] });
    expect((await database.db.query('SELECT status,next_retry_at FROM processing_batches WHERE id=$1', [original.batch])).rows[0])
      .toEqual({ status: 'waiting', next_retry_at: deadline });
    expect((await database.db.query('SELECT count(*)::int AS count FROM batch_items WHERE batch_id=$1', [original.batch])).rows[0]?.count).toBe(6);
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`run_now_batch:${current.batchId}`])).rows[0]?.value.transferredInputs).toHaveLength(4);
    expect((await database.db.query('SELECT attempts,next_retry_at FROM stage_state WHERE batch_id=$1', [original.batch])).rows[0])
      .toMatchObject({ attempts: 0, next_retry_at: expect.any(Date) });
  });
  it('transfers ownership so the original extractor cannot dispatch the same revision again', async () => {
    const original = await pendingBatch(1); const current = job('collected');
    await (await import('./run-now.js')).runNow(current, async () => {}, new AbortController().signal);
    expect(current.runNow?.inputs).toBe(1);
    const actual = await vi.importActual<typeof import('./extraction.js')>('./extraction.js');
    await actual.extractBatch(original.batch, settings);
    expect((await database.db.query('SELECT id FROM stage_state WHERE batch_id=$1', [original.batch])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT revision_id FROM batch_items WHERE batch_id=$1', [original.batch])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT revision_id FROM batch_items WHERE batch_id=$1', [current.batchId])).rows)
      .toEqual([{ revision_id: original.revisions[0] }]);
  });
  it('automatically retries failed manual batches without blocking subsequent runs', async () => {
    await source(1); const current = job();
    mocks.extraction.mockImplementation(async (batchId: string) => {
      await database.db.query("UPDATE processing_batches SET status='failed',error_code='invalid_request' WHERE id=$1", [batchId]);
      throw new (await import('./state.js')).Waiting('Failed request');
    });
    const { runNow } = await import('./run-now.js');
    expect((await runNow(current, async () => {}, new AbortController().signal)).status).toBe('waiting');
    expect((await database.db.query('SELECT completed_at FROM processing_batches WHERE id=$1', [current.batchId])).rows[0]?.completed_at).toBeNull();
    const next = job(); await runNow(next, async () => {}, new AbortController().signal);
    expect(next.batchId).toBeDefined(); expect(next.batchId).not.toBe(current.batchId);
  });
  it('does not create a batch while another pipeline lease is held', async () => {
    const { withLease } = await import('./lease.js'); const current = job();
    await withLease('news-bot-pipeline', async () => {
      const result = await (await import('./run-now.js')).runNow(current, async () => {}, new AbortController().signal);
      expect(result).toMatchObject({ status: 'waiting', message: expect.stringContaining('busy') });
      expect(current.batchId).toBeUndefined(); expect(mocks.article).not.toHaveBeenCalled();
    });
  });
  it('keeps failed source collection partial and does not retry paid fetches on restart', async () => {
    await source(1); mocks.article.mockRejectedValue(new Error('Private connector failure'));
    const current = job(); const { runNow } = await import('./run-now.js');
    const first = await runNow(current, async () => {}, new AbortController().signal);
    expect(first.status).toBe('completed_with_errors'); expect(current.runNow?.reasons.source_collection_failed).toBe(1);
    const restored = { ...current, runNow: current.runNow ? { ...current.runNow, stage: 'collecting' as const } : undefined };
    await runNow(restored, async () => {}, new AbortController().signal);
    expect(mocks.article).toHaveBeenCalledTimes(4);
    expect((await database.db.query('SELECT id FROM processing_batches WHERE manual_operation_id=$1', [current.id])).rows).toHaveLength(1);
  });
  it('pins the story preparation cap across retries without an approval hold', async () => {
    const original = await pendingBatch(1); const current = job();
    const controller = new AbortController(); controller.abort();
    await (await import('./run-now.js')).runNow(current, async () => {}, controller.signal);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [current.batchId, original.revisions[0]]);
    const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
    for (const [ordinal, id] of ids.entries()) {
      await database.db.query("INSERT INTO stories(id,status) VALUES($1,'pending')", [id]);
      await database.db.query(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,'An event',$3)`,
        [original.revisions[0], id, ordinal]);
    }
    await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)', [`pipeline_failed_story:${ids[0]}`, '{}']);
    const failures = await import('./story-failures.js');
    const work = vi.spyOn(failures, 'storyWork').mockResolvedValue('completed');
    const { finishBatchStories } = await import('./stories.js'); const { Judgments } = await import('./judgments.js');
    const { Vectors } = await import('./vectors.js'); const config = await (await import('../settings.js')).getActiveEmbeddingConfig();
    await finishBatchStories(current.batchId ?? '', settings, new Judgments(settings), new Vectors(config, settings));
    expect(work.mock.calls.map(call => call[0])).toEqual(ids.slice(0,2));
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`run_now_batch:${current.batchId}`])).rows[0]?.value)
      .toMatchObject({ storyIds: ids.slice(0, 2), omittedStories: 3 });
    await finishBatchStories(current.batchId ?? '', settings, new Judgments(settings), new Vectors(config, settings));
    expect(work.mock.calls.map(call => call[0])).toEqual([...ids.slice(0,2), ...ids.slice(0,2)]);
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`pipeline_failed_story:${ids[0]}`])).rows[0]?.value).toEqual({});
    work.mockRestore();
  });
  it('respects a saved provider wait and exposes failure reasons without dispatching another stage', async () => {
    await source(1); const current = job();
    mocks.extraction.mockImplementation(async (batchId: string) => {
      await database.db.query(`UPDATE processing_batches SET status='waiting',next_retry_at=now()+interval '6 hours',error_code='throttled' WHERE id=$1`, [batchId]);
      throw new (await import('./state.js')).Waiting('Saved wait');
    });
    const { runNow } = await import('./run-now.js');
    const first = await runNow(current, async () => {}, new AbortController().signal);
    expect(first.status).toBe('waiting'); expect(current.runNow?.reasons.throttled).toBe(1);
    expect(Date.parse(first.nextRetryAt ?? '')).toBeGreaterThan(Date.now() + 5 * 3600000);
    await runNow(current, async () => {}, new AbortController().signal);
    expect(mocks.extraction).toHaveBeenCalledOnce(); expect(mocks.article).toHaveBeenCalledTimes(4);
  });
  it('honors account-wide Telegram collection cooldowns before any read', async () => {
    await database.db.query("INSERT INTO sources(connector_type,external_id,name) VALUES('telegram','-100999','Fixture channel')");
    await database.db.query(`INSERT INTO request_attempts(provider,operation,attempt_number,status,next_retry_at,error_code)
      VALUES('telegram-user','fixture',1,'retryable',now()+interval '6 hours','telegram_rate_limit')`);
    const current = job(); const result = await (await import('./run-now.js')).runNow(current, async () => {}, new AbortController().signal);
    expect(result.status).toBe('waiting'); expect(current.runNow).toMatchObject({ stage: 'collecting', sources: 1, inputs: 0 });
    expect(current.runNow?.reasons.telegram_collection_cooldown).toBe(1); expect(mocks.userClient).not.toHaveBeenCalled();
    expect(mocks.extraction).not.toHaveBeenCalled();
  });
  it('does not dispatch after a shutdown cancellation', async () => {
    await source(1); const current = job(); const controller = new AbortController(); controller.abort();
    const result = await (await import('./run-now.js')).runNow(current, async () => {}, controller.signal);
    expect(result.status).toBe('waiting'); expect(mocks.article).not.toHaveBeenCalled(); expect(mocks.extraction).not.toHaveBeenCalled();
  });
});
