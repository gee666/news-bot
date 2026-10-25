import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `grouping_retry_${randomUUID().replaceAll('-', '')}`;
const matchStage = `match:grouping-v2:${randomUUID()}`;
const consolidateStage = 'consolidate:grouping-v2';
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let migration: string;

type FixtureTable = 'stage_state' | 'processing_batches' | 'request_attempts' | 'item_revisions'
  | 'stories' | 'publications' | 'publication_snapshots' | 'operational_state' | 'batch_items';
async function snapshot(table: FixtureTable): Promise<Record<string, unknown>[]> {
  return (await database.db.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY to_jsonb(${table})::text`)).rows;
}
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql, args)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture ID');
  return id;
}
async function batch(kind: 'automatic' | 'completed' | 'manual' | 'run_now' = 'automatic'): Promise<string> {
  const id = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,
    completed_at,manual_operation_id,next_retry_at,error_code,waiting_reason)
    VALUES($1,now(),$2,$3,$4,CASE WHEN $5 THEN now() ELSE NULL END,$6,
      now()+interval '1 hour','partial_unit_failure','Saved batch failure') RETURNING id`,
  [kind === 'completed' ? 'completed' : 'waiting', JSON.stringify(settings), settings.profileVersion,
    settings.modelVersion, kind === 'completed', kind === 'manual' ? randomUUID() : null]);
  if (kind === 'run_now') await database.db.query("INSERT INTO operational_state(key,value) VALUES($1,'{}')", [`run_now_batch:${id}`]);
  return id;
}
async function revision(): Promise<string> {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Grouping retry fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'fixture') RETURNING id", [source]);
  const id = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
    VALUES($1,1,$2,'Retained source text','Retained source text',
      '{"pipelineExtraction":[],"pipelineExtractionVersion":"events-v6"}') RETURNING id`, [item, randomUUID()]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, id]);
  return id;
}
async function item(batchId: string, revisionId: string, status = 'failed', reason: string | null = null): Promise<void> {
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id,status,disposition_reason) VALUES($1,$2,$3,$4)',
    [batchId, revisionId, status, reason]);
}
async function receipt(batchId: string, revisionId: string, name = matchStage, status = 'failed', code = 'timeout'): Promise<string> {
  return one(`INSERT INTO stage_state(batch_id,revision_id,stage,status,attempts,retry_epoch,retry_epoch_start,
    input_hash,output,next_retry_at,waiting_reason,error_code,outcome_unknown,started_at,completed_at)
    VALUES($1,$2,$3,$4,8,3,4,'retained-input','true',now()+interval '1 hour','Saved stage failure',$5,true,
      now()-interval '2 hours',CASE WHEN $4='completed' THEN now() ELSE NULL END) RETURNING id`,
  [batchId, revisionId, name, status, code]);
}
async function audit(stageId: string): Promise<void> {
  await database.db.query(`INSERT INTO request_attempts(stage_id,provider,operation,attempt_number,status,
    finished_at,error_code,response_metadata) VALUES($1::uuid,'pi',$1::uuid::text||':group:fixture',8,'unknown',now(),
      'timeout','{"outcome":"unknown","fixture":true}')`, [stageId]);
}
async function stageRows(ids: string[]): Promise<Record<string, unknown>[]> {
  return (await database.db.query<Record<string, unknown>>('SELECT * FROM stage_state WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows;
}

describe.skipIf(!url)('bounded grouping retry migration with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
    migration = await readFile(new URL('../../migrations/206_bounded_grouping_retry.sql', import.meta.url), 'utf8');
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE processing_batches,sources,stories,operational_state CASCADE');
  });
  afterAll(async () => {
    try { await database?.db.end(); }
    finally {
      try { if (admin) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await admin?.end(); vi.unstubAllEnvs(); }
    }
  });

  it.each(['timeout', 'context_limit', 'invalid_output', 'invalid_request'])(
    'resets %s grouping failures in every unfinished automatic duplicate snapshot', async code => {
      const revisionId = await revision();
      const batches = [await batch(), await batch()];
      const ids: string[] = [];
      for (const [index, batchId] of batches.entries()) {
        await item(batchId, revisionId, 'failed', 'grouping_failure');
        for (const name of [matchStage, consolidateStage]) {
          const id = await receipt(batchId, revisionId, name, index ? 'waiting' : 'failed', code);
          ids.push(id); await audit(id);
        }
      }
      const before = await stageRows(ids);
      const audits = await snapshot('request_attempts');
      await database.db.query(migration);
      expect(await stageRows(ids)).toEqual(before.map(row => ({ ...row, status: 'pending', attempts: 0,
        retry_epoch: 4, retry_epoch_start: 0, next_retry_at: null, error_code: null, waiting_reason: null,
        outcome_unknown: false, updated_at: expect.any(Date) })));
      const queued = await database.db.query('SELECT id,status,completed_at,next_retry_at,error_code,waiting_reason FROM processing_batches ORDER BY id');
      expect(queued.rows).toEqual([...batches].sort().map(id => ({ id, status: 'queued', completed_at: null,
        next_retry_at: null, error_code: null, waiting_reason: null })));
      expect((await snapshot('batch_items')).map(row => ({ status: row.status, reason: row.disposition_reason })))
        .toEqual(batches.map(() => ({ status: 'pending', reason: null })));
      expect(await snapshot('request_attempts')).toEqual(audits);
      const reset = await snapshot('stage_state');
      await database.db.query(migration);
      expect(await snapshot('stage_state')).toEqual(reset);
      expect(await snapshot('request_attempts')).toEqual(audits);
    });

  it('preserves successful receipts, extraction, publications and all excluded work', async () => {
    const revisionId = await revision();
    const active = await batch(); await item(active, revisionId);
    const affected = await receipt(active, revisionId); await audit(affected);
    const protectedIds: string[] = [];
    for (const kind of ['completed', 'manual', 'run_now'] as const) {
      const batchId = await batch(kind); await item(batchId, revisionId);
      // Only failed historical automatic receipts may be retired, never successful ones.
      const id = await receipt(batchId, revisionId, matchStage, kind === 'completed' ? 'completed' : 'failed');
      protectedIds.push(id); await audit(id);
      protectedIds.push(await receipt(batchId, revisionId, consolidateStage, kind === 'completed' ? 'completed' : 'waiting'));
    }
    const historical = await batch('completed'); await item(historical, revisionId);
    protectedIds.push(await receipt(historical, revisionId, `${matchStage}:other`, 'waiting'));
    protectedIds.push(await receipt(historical, await revision(), matchStage));
    for (const status of ['completed', 'pending', 'running', 'skipped']) {
      protectedIds.push(await receipt(active, revisionId, `match:grouping-v2:${randomUUID()}`, status));
    }
    for (const code of ['authentication', 'transient', 'interrupted_request']) {
      protectedIds.push(await receipt(active, revisionId, `match:grouping-v2:${randomUUID()}`, 'failed', code));
    }
    const extraction = await receipt(active, revisionId, 'extract:events-v6', 'completed');
    protectedIds.push(extraction);
    await database.db.query("UPDATE stage_state SET output='[]' WHERE id=$1", [extraction]);
    for (const name of ['match:grouping-v1:old', 'consolidate:grouping-v1', 'research:generation-v10:fixture']) {
      protectedIds.push(await receipt(active, revisionId, name, 'waiting'));
    }
    const storyId = await one("INSERT INTO stories(status,chosen_excerpt) VALUES('completed','Published source text') RETURNING id");
    const snapshotId = await one(`INSERT INTO publication_snapshots(story_id,content)
      VALUES($1,'{"headline":"Published","score":7,"details":"Original","detailsKind":"excerpt","sources":[]}') RETURNING id`, [storyId]);
    await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,callback_id,status,published_at)
      VALUES($1,$2,'fixture','42',$3,'published',now())`, [storyId, snapshotId, randomUUID()]);
    const protectedStages = await stageRows(protectedIds);
    const tables = ['request_attempts', 'item_revisions', 'stories', 'publications', 'publication_snapshots', 'operational_state'] as const;
    const unchanged = await Promise.all(tables.map(table => snapshot(table)));
    const batches = (await snapshot('processing_batches')).filter(row => row.id !== active);
    const items = (await snapshot('batch_items')).filter(row => row.batch_id !== active);
    await database.db.query(migration);
    expect((await stageRows([affected]))[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await stageRows(protectedIds)).toEqual(protectedStages);
    expect(await Promise.all(tables.map(table => snapshot(table)))).toEqual(unchanged);
    expect((await snapshot('processing_batches')).filter(row => row.id !== active)).toEqual(batches);
    expect((await snapshot('batch_items')).filter(row => row.batch_id !== active)).toEqual(items);
  });

  it.each(['failed', 'waiting'])('retires only matching historical %s receipts so runtime cannot inherit exhausted work', async status => {
    const revisionId = await revision();
    const active = await batch(); const historical = await batch('completed');
    await item(active, revisionId); await item(historical, revisionId);
    const current: string[] = []; const retired: string[] = [];
    for (const name of [matchStage, consolidateStage]) {
      current.push(await receipt(active, revisionId, name));
      const id = await receipt(historical, revisionId, name, status);
      await database.db.query('UPDATE stage_state SET attempts=17,retry_epoch_start=12 WHERE id=$1', [id]);
      retired.push(id); await audit(id);
    }
    const before = await stageRows(retired);
    const audits = await snapshot('request_attempts');
    const historicalBatch = (await snapshot('processing_batches')).filter(row => row.id === historical);
    const historicalItems = (await snapshot('batch_items')).filter(row => row.batch_id === historical);
    await database.db.query(migration);
    const expected = before.map(row => ({ ...row, status: 'skipped', next_retry_at: null,
      waiting_reason: 'Superseded by bounded grouping retry.', updated_at: expect.any(Date) }));
    expect(await stageRows(retired)).toEqual(expected);
    expect((await snapshot('processing_batches')).filter(row => row.id === historical)).toEqual(historicalBatch);
    expect((await snapshot('batch_items')).filter(row => row.batch_id === historical)).toEqual(historicalItems);
    const { stage } = await import('./state.js');
    const storyId = randomUUID(); const matched = vi.fn(async () => storyId); const consolidated = vi.fn(async () => true);
    await expect(stage(active, { revisionId }, matchStage, settings, z.uuid(), matched)).resolves.toBe(storyId);
    await expect(stage(active, { revisionId }, consolidateStage, settings, z.boolean(), consolidated)).resolves.toBe(true);
    expect(matched).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempt: 1 }));
    expect(consolidated).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attempt: 1 }));
    expect(await stageRows(current)).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: matchStage, status: 'completed', attempts: 0, output: storyId }),
      expect.objectContaining({ stage: consolidateStage, status: 'completed', attempts: 0, output: true }),
    ]));
    expect(await stageRows(retired)).toEqual(expected);
    expect(await snapshot('request_attempts')).toEqual(audits);
  });

  it('does not reopen superseded, rejected or already completed batch items', async () => {
    const batchId = await batch();
    for (const [status, reason] of [['failed', 'superseded_revision'], ['rejected', 'outside_collection_window'], ['completed', null]]) {
      const revisionId = await revision();
      if (!status) throw new Error('Missing fixture status');
      await item(batchId, revisionId, status, reason ?? null);
      await receipt(batchId, revisionId);
    }
    const before = await snapshot('batch_items');
    await database.db.query(migration);
    expect(await snapshot('batch_items')).toEqual(before);
    expect((await snapshot('stage_state')).every(row => row.status === 'pending')).toBe(true);
  });
});
