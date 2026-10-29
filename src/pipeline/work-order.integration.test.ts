import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { ProcessingYield } from './processing-slice.js';

const mocks = vi.hoisted(() => ({ extract: vi.fn(), group: vi.fn() }));
vi.mock('./generation-model.js', () => ({ generationClient: async () => ({}),
  recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
vi.mock('./extraction-model.js', () => ({ extractEvents: mocks.extract }));
vi.mock('./source-links.js', () => ({ classifyItemLinks: async () => {} }));
vi.mock('./grouping-model.js', () => ({ GROUPING_VERSION: 'work-order-fixture', groupReport: mocks.group }));
const url = process.env.TEST_DATABASE_URL;
const schema = `work_order_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let vectors: import('./vectors.js').Vectors;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function batch(): Promise<string> {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
}
async function item(batchId: string, text: string): Promise<string> {
  const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test','public') RETURNING id", [randomUUID()]);
  const item = await one("INSERT INTO source_items(source_id,external_id,published_at) VALUES($1,'1',now()) RETURNING id", [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
  return revision;
}

describe.skipIf(!url)('ready input progresses around a deferred unit', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    const store = await import('../settings.js'); settings = await store.saveSettings({ embeddingDimensions: 3 });
    vectors = new (await import('./vectors.js')).Vectors(await store.getActiveEmbeddingConfig(), settings);
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE sources,stories,processing_batches,model_cache CASCADE');
    await database.db.query('DELETE FROM operational_state');
    mocks.extract.mockReset().mockImplementation(async (text: string) => [{ parts: [{ start: 0, end: text.length }], context: [] }]);
    mocks.group.mockReset().mockResolvedValue([]);
  });
  afterAll(async () => {
    await vectors?.close(); await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  it('extracts an untouched sibling before resuming a previously checkpointed comparison', async () => {
    const batchId = await batch(); const slow = await item(batchId, 'Slow event.');
    const { extractBatch } = await import('./extraction.js');
    const { stage } = await import('./state.js'); const { z } = await import('zod');
    await expect(extractBatch(batchId, settings, async revisionId => {
      await stage(batchId, { revisionId }, 'match:partial', settings, z.boolean(), async () => { throw new ProcessingYield(); });
    })).rejects.toBeInstanceOf(ProcessingYield);
    const fresh = await item(batchId, 'Fresh event.');
    const visited: string[] = [];
    await extractBatch(batchId, settings, async revisionId => { visited.push(revisionId); });
    expect(visited).toEqual([fresh, slow]);
    expect(mocks.extract.mock.calls.map(([text]) => text)).toEqual(['Slow event.', 'Fresh event.']);
    expect((await database.db.query(`SELECT status,attempts,next_retry_at>now() AS cooling_down FROM stage_state
      WHERE batch_id=$1 AND stage='match:partial'`, [batchId])).rows)
      .toEqual([{ status: 'waiting', attempts: 0, cooling_down: true }]);
  });
  it('assigns another mention from the same source while a long comparison is deferred', async () => {
    const batchId = await batch(); const text = 'Slow event.\nHealthy event.'; const revision = await item(batchId, text);
    await (await import('./extraction-store.js')).applyExtraction(batchId, revision, text,
      [{ start: 0, end: 11 }, { start: 12, end: text.length }]);
    const slow = await one("SELECT id FROM story_mentions WHERE revision_id=$1 AND text='Slow event.'", [revision]);
    const healthy = await one("SELECT id FROM story_mentions WHERE revision_id=$1 AND text='Healthy event.'", [revision]);
    const save = vi.spyOn(vectors, 'save').mockResolvedValue([1, 2, 3]);
    mocks.group.mockImplementation(async (incoming: { text: string }) => {
      if (incoming.text === 'Slow event.') throw new ProcessingYield();
      return [];
    });
    const { matchBatch } = await import('./matching.js');
    try {
      await expect(matchBatch(batchId, settings, vectors, [slow])).rejects.toBeInstanceOf(ProcessingYield);
      await matchBatch(batchId, settings, vectors);
      expect(mocks.group.mock.calls.map(([incoming]) => incoming.text)).toEqual(['Slow event.', 'Healthy event.']);
      expect((await database.db.query('SELECT story_id IS NOT NULL AS assigned FROM story_mentions WHERE id=$1', [healthy])).rows)
        .toEqual([{ assigned: true }]);
      expect((await database.db.query('SELECT story_id IS NULL AS pending FROM story_mentions WHERE id=$1', [slow])).rows)
        .toEqual([{ pending: true }]);
      expect((await database.db.query(`SELECT attempts,status FROM stage_state WHERE batch_id=$1
        AND stage=$2`, [batchId, `match:work-order-fixture:${slow}`])).rows)
        .toEqual([{ attempts: 0, status: 'waiting' }]);
    } finally { save.mockRestore(); }
  });
  it('does not hold a collected manual batch for an unrelated automatic connector cooldown', async () => {
    const batchId = await batch();
    await database.db.query('UPDATE processing_batches SET manual_operation_id=$2 WHERE id=$1', [batchId, randomUUID()]);
    await database.db.query(`INSERT INTO request_attempts(provider,operation,attempt_number,status,error_code,next_retry_at)
      VALUES('telegram-user',$1,1,'retryable','telegram_rate_limit',now()+interval '1 hour')`, [randomUUID()]);
    await (await import('./item-failures.js')).completeBatchItems(batchId);
    expect((await database.db.query('SELECT status,next_retry_at FROM processing_batches WHERE id=$1', [batchId])).rows)
      .toEqual([{ status: 'completed', next_retry_at: null }]);
  });
  it('skips a source input in failed-provider backoff while extracting a healthy sibling', async () => {
    const batchId = await batch(); const blocked = await item(batchId, 'Blocked source.');
    const fresh = await item(batchId, 'Fresh source.');
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,attempts,next_retry_at)
      VALUES($1,$2,'extract:events-v6','waiting',1,now()+interval '1 hour')`, [batchId, blocked]);
    await (await import('./extraction.js')).extractBatch(batchId, settings);
    expect(mocks.extract.mock.calls.map(([text]) => text)).toEqual(['Fresh source.']);
    expect((await database.db.query("SELECT metadata ? 'pipelineExtraction' AS extracted FROM item_revisions WHERE id=$1", [fresh])).rows)
      .toEqual([{ extracted: true }]);
  });
});
