import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { ModelRequestError, failureMetadata, RequestFault } from '../models/errors.js';
import { ProcessingYield, withProcessingSlice } from './processing-slice.js';

const mocks = vi.hoisted(() => ({ empty: vi.fn(), collection: vi.fn(), stories: vi.fn(), clock: 0 }));
vi.mock('./generation-model.js', () => ({ generationClient: async () => ({}), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
vi.mock('./extraction-model.js', () => ({ extractEvents: mocks.empty }));
vi.mock('./grouping-model.js', () => ({ GROUPING_VERSION: 'grouping-v1', groupReport: async () => [] }));
vi.mock('./collection.js', () => ({ collectBatch: mocks.collection }));
vi.mock('./stories.js', () => ({ finishBatchStories: mocks.stories }));
vi.mock('../models/jev.js', async original => ({ ...await original<typeof import('../models/jev.js')>(), JevClient: class {
  async judge(template: string, state: unknown, context: { operationId: string }) {
    if (JSON.stringify(state).includes('Broken')) throw new ModelRequestError(
      failureMetadata(new RequestFault('transient'), context.operationId, 'jev', 1, 0));
    const choice = template==='story_count' ? JSON.stringify(state).includes('Empty') ? '2' : '1'
      : template==='news_eligibility' ? 'eligible' : template==='extraction_event_role' ? 'current' : 'different';
    return { answers: { answer: template==='split_validation' ? { type: 'noul', noul: 1 }
      : { type: 'choice', choice, probabilities: {}, confidence: 1 } }, metrics: {}, model: 'offline' };
  }
  async close() {}
} }));
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  async embed(input: string[], context: { operationId: string }) {
    if (input.some(text => text.includes('Broken embedding'))) throw new ModelRequestError(
      failureMetadata(new RequestFault('transient'),context.operationId,'embedding',1,0));
    return { vectors: [[1,2,3]] };
  }
  async close() {}
} }));
const url = process.env.TEST_DATABASE_URL;
const schema = `processing_retry_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;

let vectors: import('./vectors.js').Vectors;
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql, args)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture ID');
  return id;
}
async function batch(status='processing'): Promise<string> {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES($1,now(),$2,$3,$4) RETURNING id`, [status,JSON.stringify(settings),settings.profileVersion,settings.modelVersion]);
}
async function item(batchId: string, text: string): Promise<string> {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test','public') RETURNING id`, [randomUUID()]);
  const id = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at) VALUES($1,'1','https://example.com/news',now()) RETURNING id`, [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [id,randomUUID(),text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [id,revision]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId,revision]);
  return revision;
}
describe.skipIf(!url)('automatic processing and restart', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    const store = await import('../settings.js'); settings = await store.saveSettings({ embeddingDimensions: 3 });

    vectors = new (await import('./vectors.js')).Vectors(await store.getActiveEmbeddingConfig(), settings);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await database.db.query('TRUNCATE sources,stories,processing_batches,model_cache CASCADE');
    await database.db.query('DELETE FROM operational_state');
    mocks.collection.mockResolvedValue(undefined);
    mocks.stories.mockResolvedValue({ completedStories: 0, failedStories: 0, skippedStories: 0 });
    mocks.empty.mockImplementation(async (text: string) => {
      if (text.includes('Broken')) throw new ModelRequestError(failureMetadata(new RequestFault('transient'), 'extract', 'pi', 1, 0));
      return text.includes('Empty') ? [] : [{ parts: [{ start: 0, end: text.length }], context: [] }];
    });
    mocks.clock=0;
  });
  afterAll(async () => {
    await vectors?.close(); await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  it('migrates retired settings and unfinished stages without deleting successful extraction or audits', async () => {
    const automatic=await batch('waiting'); const revision=await item(automatic,'Empty old recap.');
    await (await import('./extraction-store.js')).applyExtraction(automatic,revision,'Empty old recap.',[]);
    await database.db.query("UPDATE app_settings SET value=value||'{\"matchCandidateLimit\":5,\"headlineBatchSize\":10}'::jsonb");
    await database.db.query("UPDATE processing_batches SET settings_snapshot=settings_snapshot||'{\"matchCandidateLimit\":5,\"headlineBatchSize\":10}'::jsonb");
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,output)
      VALUES($1,$2,'extract:events-v5','completed','[]'),($1,$2,'source_links:item:old','waiting',NULL)`, [automatic,revision]);
    const sql=await readFile(new URL('../../migrations/193_simple_association.sql',import.meta.url),'utf8');
    await database.db.query(sql);
    expect((await database.db.query("SELECT value ? 'matchCandidateLimit' AS retired FROM app_settings")).rows).toEqual([{retired:false}]);
    expect((await database.db.query("SELECT settings_snapshot ? 'headlineBatchSize' AS retired FROM processing_batches")).rows).toEqual([{retired:false}]);
    expect((await database.db.query('SELECT status FROM stage_state WHERE batch_id=$1 ORDER BY stage',[automatic])).rows)
      .toEqual([{status:'completed'},{status:'skipped'}]);
    await (await import('./batches.js')).processBatch(false,true,automatic);
    expect(mocks.empty).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[automatic])).rows).toEqual([{status:'completed'}]);
  });
  it('processes least-recently-served intake before newer pending batches and ignores future retries', async () => {
    const old=await batch('queued'); await item(old,'Old release.');
    await database.db.query("UPDATE processing_batches SET cutoff_at=now()-interval '2 days',last_served_at=now()-interval '2 days' WHERE id=$1",[old]);
    const future=await batch('waiting'); await item(future,'Future retry.');
    await database.db.query("UPDATE processing_batches SET next_retry_at=now()+interval '1 hour',last_served_at=now()-interval '3 days' WHERE id=$1",[future]);
    const recent=await batch('queued'); await item(recent,'Recent new release.');
    const served: string[]=[];
    mocks.collection.mockImplementation(async (id:string)=>{served.push(id); throw new ProcessingYield();});
    const process=(await import('./batches.js')).processBatch;
    await process(false,true);
    expect(served).toEqual([old]);
    // Make the checkpoint due again. Its new last-served timestamp must give another batch a turn.
    await database.db.query("UPDATE processing_batches SET next_retry_at=now()-interval '1 second' WHERE id=$1",[old]);
    await process(false,true);
    expect(served).toEqual([old,recent]);
    expect((await database.db.query('SELECT retry_attempts FROM processing_batches WHERE id=ANY($1::uuid[])',[served])).rows)
      .toEqual([{retry_attempts:0},{retry_attempts:0}]);
  });
  it('bounds repeated batch infrastructure failures instead of resetting to attempt one', async () => {
    const id=await batch('queued');
    mocks.collection.mockRejectedValue(new Error('offline'));
    for(let attempt=1;attempt<=settings.requestMaxAttempts;attempt++) {
      await expect((await import('./batches.js')).processBatch(false,true)).rejects.toThrow('offline');
      const row=(await database.db.query('SELECT status,retry_attempts,next_retry_at FROM processing_batches WHERE id=$1',[id])).rows[0];
      expect(row).toMatchObject({status:attempt<settings.requestMaxAttempts ? 'waiting' : 'failed',retry_attempts:attempt});
      if(attempt<settings.requestMaxAttempts) expect(row.next_retry_at.getTime()).toBeGreaterThan(Date.now());
      await database.db.query('UPDATE processing_batches SET next_retry_at=NULL WHERE id=$1',[id]);
    }
    await (await import('./batches.js')).processBatch(false,true,id);
    expect(mocks.collection).toHaveBeenCalledTimes(settings.requestMaxAttempts);
  });
  it('preserves a collection-owned terminal decision without buying another batch retry', async () => {
    const id=await batch('queued');
    mocks.collection.mockImplementation(async () => {
      await database.db.query("UPDATE processing_batches SET status='failed',error_code='telegram_collection_failed',next_retry_at=NULL WHERE id=$1",[id]);
      throw new Error('terminal connector failure');
    });
    await expect((await import('./batches.js')).processBatch(false,true)).rejects.toThrow('terminal connector failure');
    expect((await database.db.query('SELECT status,retry_attempts,error_code FROM processing_batches WHERE id=$1',[id])).rows)
      .toEqual([{status:'failed',retry_attempts:0,error_code:'telegram_collection_failed'}]);
    await (await import('./batches.js')).processBatch(false,true);
    expect(mocks.collection).toHaveBeenCalledOnce();
  });
  it('does not let reopened association-only batches starve unfinished news', async () => {
    const news=await batch('queued'); const revision=await item(news,'Recent real release.');
    await database.db.query("UPDATE processing_batches SET cutoff_at=now()-interval '1 hour' WHERE id=$1",[news]);
    const enrichment=await batch('waiting'); const empty=await item(enrichment,'Empty source-only recap.');
    await (await import('./extraction-store.js')).applyExtraction(enrichment,empty,'Empty source-only recap.',[]);
    await (await import('./batches.js')).processBatch(false,true);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[revision])).rows[0]?.story_id).toBeTruthy();
    expect((await database.db.query('SELECT count(*)::int AS n FROM stage_state WHERE batch_id=$1',[enrichment])).rows).toEqual([{n:0}]);
    await (await import('./batches.js')).processBatch(false,true);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[enrichment])).rows).toEqual([{status:'completed'}]);
    expect(mocks.empty).toHaveBeenCalledOnce();
  });
  it('groups saved orphan reports before starting newer raw extraction', async () => {
    const orphan=await batch('queued'); const revision=await item(orphan,'Saved report.');
    await (await import('./extraction-store.js')).applyExtraction(orphan,revision,'Saved report.',[{start:0,end:13}]);
    const raw=await batch('queued'); await item(raw,'Newer raw report.');
    await (await import('./batches.js')).processBatch(false,true);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[revision])).rows[0]?.story_id).toBeTruthy();
    expect((await database.db.query('SELECT count(*)::int AS n FROM stage_state WHERE batch_id=$1',[raw])).rows).toEqual([{n:0}]);
  });
  it('matches committed mentions before extraction waits on unfinished links', async () => {
    const batchId = await batch(); const revision = await item(batchId,'Recent extracted release.');
    await (await import('./extraction-store.js')).applyExtraction(batchId,revision,'Recent extracted release.',[{start:0,end:25}]);
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
      VALUES($1,$2,'links:events-v5','waiting',now()+interval '1 hour')`,[batchId,revision]);
    await (await import('./batches.js')).processBatch(false,true,batchId);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[revision])).rows[0]?.story_id).toBeTruthy();
    expect(mocks.empty).not.toHaveBeenCalled();
  });
  it('does not embed or rematch assigned mentions and retires their obsolete waits', async () => {
    const batchId = await batch(); const revision = await item(batchId,'Assigned release.');
    await (await import('./extraction-store.js')).applyExtraction(batchId,revision,'Assigned release.',[{start:0,end:17}]);
    const {matchBatch}=await import('./matching.js'); await matchBatch(batchId,settings,vectors);
    const mention=(await database.db.query<{id:string}>('SELECT id FROM story_mentions WHERE revision_id=$1',[revision])).rows[0];
    if(!mention) throw new Error('Missing mention');
    await database.db.query("UPDATE stage_state SET status='waiting',next_retry_at=now()+interval '1 hour' WHERE batch_id=$1",[batchId]);
    const save=vi.spyOn(vectors,'save');
    await matchBatch(batchId,settings,vectors);
    expect(save).not.toHaveBeenCalled(); save.mockRestore();
    expect((await database.db.query('SELECT DISTINCT status FROM stage_state WHERE batch_id=$1',[batchId])).rows).toEqual([{status:'skipped'}]);
  });
  it('never reruns confirmed_empty after a checkpoint between extraction commit and links', async () => {
    vi.stubEnv('PROCESSING_SLICE_MS', '1000');
    vi.spyOn(performance, 'now').mockImplementation(() => mocks.clock);
    mocks.empty.mockImplementation(async () => { mocks.clock=1001; return []; });
    const batchId = await batch(); const revision = await item(batchId, 'Empty recap.\nNothing current.');
    const { extractBatch } = await import('./extraction.js');
    await expect(withProcessingSlice(() => extractBatch(batchId,settings))).rejects.toBeInstanceOf(ProcessingYield);
    expect(mocks.empty).toHaveBeenCalledOnce();
    // Older deployments can have only the successful stage receipt.
    await database.db.query("UPDATE item_revisions SET metadata=metadata-'pipelineExtraction'-'pipelineExtractionVersion' WHERE id=$1", [revision]);
    await withProcessingSlice(() => extractBatch(batchId,settings));
    expect(mocks.empty).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT status,attempts,output FROM stage_state WHERE batch_id=$1 AND stage=$2',
      [batchId,'extract:events-v6'])).rows).toEqual([{ status: 'completed', attempts: 0, output: [] }]);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,revision])).rows)
      .toEqual([{ status: 'rejected' }]);
    vi.restoreAllMocks(); vi.stubEnv('PROCESSING_SLICE_MS', '120000');
  });
  it('a failed item does not stop a successfully extracted sibling from reaching matching', async () => {
    const batchId = await batch(); await item(batchId, 'Broken provider input.');
    const good = await item(batchId, 'Gamma released a security fix.');
    const { extractBatch } = await import('./extraction.js');
    const { matchBatch } = await import('./matching.js');
    await extractBatch(batchId,settings,async revision => {
      const mentions = await database.db.query<{ id: string }>('SELECT id FROM story_mentions WHERE revision_id=$1', [revision]);
      await matchBatch(batchId,settings,vectors,mentions.rows.map(row => row.id));
    });
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1', [good])).rows[0]?.story_id).toBeTruthy();
    expect((await database.db.query("SELECT status FROM stage_state WHERE batch_id=$1 AND error_code='transient'", [batchId])).rows)
      .toEqual([{ status: 'waiting' }]);
  });
  it('a failed reconciliation backs off independently while its sibling completes', async () => {
    const batchId = await batch();
    await item(batchId, 'First revision.'); await item(batchId, 'Second revision.');
    const ordered = await database.db.query<{ id: string }>('SELECT revision_id AS id FROM batch_items WHERE batch_id=$1 ORDER BY revision_id', [batchId]);
    const first = ordered.rows[0]?.id;
    if (!first) throw new Error('Missing revision');
    const transaction = database.transaction;
    const work = vi.spyOn(database, 'transaction').mockRejectedValueOnce(new Error('Reconciliation failed'))
      .mockImplementation(transaction);
    try {
      const { reconcileEdits } = await import('./revisions.js');
      await reconcileEdits(batchId, settings);
      expect(work).toHaveBeenCalledTimes(2);
      expect((await database.db.query("SELECT status,attempts FROM stage_state WHERE batch_id=$1 AND stage='reconcile_edit' ORDER BY revision_id", [batchId])).rows)
        .toEqual([{ status: 'waiting', attempts: 1 }, { status: 'completed', attempts: 0 }]);
      await reconcileEdits(batchId, settings);
      expect(work).toHaveBeenCalledTimes(2);
      await database.db.query("UPDATE stage_state SET status='failed',attempts=$3,next_retry_at=NULL WHERE batch_id=$1 AND revision_id=$2", [batchId, first, settings.requestMaxAttempts]);
      await reconcileEdits(batchId, settings);
      expect(work).toHaveBeenCalledTimes(2);
    } finally { work.mockRestore(); }
  });
  it('acknowledges only proven revision work, leaving unstarted and unassigned inputs unfinished', async () => {
    const batchId = await batch(); const first = await item(batchId,'Finished event.');
    const unstarted = await item(batchId,'Unstarted event.'); const unassigned = await item(batchId,'Unassigned event.');
    const { applyExtraction } = await import('./extraction-store.js');
    for (const [revision,text] of [[first,'Finished event.'],[unassigned,'Unassigned event.']]) {
      if (!revision || !text) throw new Error('Missing fixture');
      await applyExtraction(batchId,revision,text,[{start:0,end:text.length}]);
      await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,output)
        VALUES($1,$2,'links:events-v5','completed','true')`, [batchId,revision]);
    }
    const mention = (await database.db.query<{ id: string }>('SELECT id FROM story_mentions WHERE revision_id=$1', [first])).rows[0];
    if (!mention) throw new Error('Missing mention');
    await (await import('./matching.js')).matchBatch(batchId,settings,vectors,[mention.id]);
    const { completeBatchItems } = await import('./item-failures.js');
    await completeBatchItems(batchId,undefined,first);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,first])).rows)
      .toEqual([{status:'completed'}]);
    await completeBatchItems(batchId,undefined,unstarted); await completeBatchItems(batchId,undefined,unassigned);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,unstarted])).rows)
      .toEqual([{status:'pending'}]);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,unassigned])).rows)
      .toEqual([{status:'processing'}]);
    await completeBatchItems(batchId);
    expect((await database.db.query('SELECT status,completed_at FROM processing_batches WHERE id=$1', [batchId])).rows)
      .toEqual([{status:'waiting',completed_at:null}]);
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status)
      VALUES($1,$2,'match:terminal','failed')`, [batchId,unassigned]);
    await completeBatchItems(batchId,undefined,unassigned);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,unassigned])).rows)
      .toEqual([{status:'failed'}]);
  });
  it('commits a completed input before its story work overruns and the next input checkpoints', async () => {
    const batchId = await batch(); const first = await item(batchId,'First release.'); const second = await item(batchId,'Second release.');
    const previous = process.env.PROCESSING_SLICE_MS; process.env.PROCESSING_SLICE_MS='1000';
    const now = vi.spyOn(performance,'now').mockImplementation(() => mocks.clock);
    mocks.stories.mockImplementationOnce(async () => { mocks.clock=1001; return {completedStories:1,failedStories:0,skippedStories:0}; });
    try {
      await (await import('./batches.js')).processBatch(false,true);
      expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,first])).rows)
        .toEqual([{status:'completed'}]);
      expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,second])).rows)
        .toEqual([{status:'pending'}]);
      expect((await database.db.query('SELECT status,completed_at FROM processing_batches WHERE id=$1', [batchId])).rows)
        .toEqual([{status:'waiting',completed_at:null}]);
    } finally {
      now.mockRestore();
      if (previous===undefined) delete process.env.PROCESSING_SLICE_MS; else process.env.PROCESSING_SLICE_MS=previous;
    }
  });
  it('duplicate collection snapshots share an exhausted revision retry budget', async () => {
    const first=await batch(); const revision=await item(first,'Broken original input.');
    const { extractBatch }=await import('./extraction.js');
    await extractBatch(first,settings);
    await database.db.query("UPDATE stage_state SET status='failed',attempts=$2,next_retry_at=NULL WHERE batch_id=$1",[first,settings.requestMaxAttempts]);
    const second=await batch();
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)',[second,revision]);
    await extractBatch(second,settings);
    expect((await database.db.query('SELECT status,attempts,next_retry_at FROM stage_state WHERE batch_id=$1',[second])).rows)
      .toEqual([{status:'failed',attempts:settings.requestMaxAttempts,next_retry_at:null}]);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1',[second])).rows).toEqual([{status:'failed'}]);
  });
  it('a matching failure does not block another mention from the same extracted item', async () => {
    const batchId=await batch(); const text='Broken embedding.\nHealthy event.';
    const revision=await item(batchId,text);
    await (await import('./extraction-store.js')).applyExtraction(batchId,revision,text,
      [{start:0,end:17},{start:18,end:text.length}]);
    await (await import('./matching.js')).matchBatch(batchId,settings,vectors);
    const mentions=await database.db.query<{story_id:string|null}>('SELECT story_id FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal',[revision]);
    expect(mentions.rows[0]?.story_id).toBeNull(); expect(mentions.rows[1]?.story_id).toBeTruthy();
  });
  it('migration recovers old high-attempt parked work without discarding receipts or queued items', async () => {
    const stuck = await batch('failed'); const revision = await item(stuck, 'Empty old recap.');
    await (await import('./extraction-store.js')).applyExtraction(stuck,revision,'Empty old recap.',[]);
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,attempts,output)
      VALUES($1,$2,'count','completed',34,'"2"'),($1,$2,'extract:events-v5','failed',11,NULL)`, [stuck,revision]);
    const queued: string[] = [];
    for (let index=0; index<4; index++) { const id=await batch('queued'); queued.push(id); await item(id,'Empty queued recap.'); }
    const orphanBatch=await batch('completed'); const orphan=await item(orphanBatch,'Healthy orphan event.');
    await (await import('./extraction-store.js')).applyExtraction(orphanBatch,orphan,'Healthy orphan event.',[{start:0,end:21}]);
    await database.db.query("UPDATE batch_items SET status='completed' WHERE batch_id=$1",[orphanBatch]);
    await database.db.query('UPDATE processing_batches SET completed_at=now() WHERE id=$1',[orphanBatch]);
    const sql=await readFile(new URL('../../migrations/190_automatic_processing.sql',import.meta.url),'utf8');
    await database.db.query(sql);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[stuck])).rows).toEqual([{status:'queued'}]);
    expect((await database.db.query("SELECT attempts,output FROM stage_state WHERE batch_id=$1 AND stage='count'",[stuck])).rows)
      .toEqual([{attempts:0,output:'2'}]);
    expect((await database.db.query('SELECT count(*)::int AS count FROM item_revisions')).rows).toEqual([{count:6}]);
    expect((await database.db.query('SELECT count(*)::int AS count FROM processing_batches WHERE id=ANY($1::uuid[])',[queued])).rows).toEqual([{count:4}]);
    await (await import('./batches.js')).processBatch(false,true,stuck);
    expect(mocks.empty).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[stuck])).rows).toEqual([{status:'completed'}]);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1',[orphanBatch])).rows).toEqual([{status:'queued'}]);
    await (await import('./batches.js')).processBatch(false,true,orphanBatch);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1',[orphan])).rows[0]?.story_id).toBeTruthy();
  });
  it.each(['pending','running','waiting','failed','completed'] as const)('migration retires obsolete %s headline stages without losing receipts or audits', async status => {
    const batchId = await batch('waiting'); const revision = await item(batchId, 'Empty retained recap.');
    await (await import('./extraction-store.js')).applyExtraction(batchId,revision,'Empty retained recap.',[]);
    const storyId = await one("INSERT INTO stories(chosen_excerpt) VALUES('Historical story') RETURNING id");
    const stageId = await one(`INSERT INTO stage_state(batch_id,story_id,stage,status,attempts,output,next_retry_at)
      VALUES($1,$2,$3,$4,4,'true',CASE WHEN $4='completed' THEN NULL ELSE now()+interval '1 hour' END) RETURNING id`,
    [batchId,storyId,status==='pending' ? 'headlines' : 'headlines:generation-v10:legacy',status]);
    const auditId = await one(`INSERT INTO request_attempts(stage_id,provider,operation,attempt_number,status)
      VALUES($1,'pi','legacy_headlines',4,'retryable') RETURNING id`, [stageId]);
    const audit = (await database.db.query('SELECT * FROM request_attempts WHERE id=$1', [auditId])).rows;
    await database.db.query("UPDATE processing_batches SET next_retry_at=now()+interval '1 hour' WHERE id=$1", [batchId]);
    const sql = await readFile(new URL('../../migrations/190_automatic_processing.sql',import.meta.url),'utf8');
    await database.db.query(sql);
    expect((await database.db.query('SELECT status,attempts,output,next_retry_at FROM stage_state WHERE id=$1', [stageId])).rows)
      .toEqual([{ status: status==='completed' ? 'completed' : 'skipped', attempts: status==='completed' ? 0 : 4,
        output: true, next_retry_at: null }]);
    expect((await database.db.query('SELECT * FROM request_attempts WHERE id=$1', [auditId])).rows).toEqual(audit);
    expect((await database.db.query('SELECT next_retry_at FROM processing_batches WHERE id=$1', [batchId])).rows)
      .toEqual([{ next_retry_at: null }]);
    await (await import('./batches.js')).processBatch(false,true,batchId);
    expect((await database.db.query('SELECT status,completed_at IS NOT NULL AS completed FROM processing_batches WHERE id=$1', [batchId])).rows)
      .toEqual([{ status: 'completed', completed: true }]);
    expect(mocks.empty).not.toHaveBeenCalled();
  });
  it('a parked failed batch does not block a later queued batch', async () => {
    const failed = await batch('failed'); await item(failed, 'Broken input.');
    await database.db.query("UPDATE processing_batches SET next_retry_at=now()+interval '1 hour',error_code='transient' WHERE id=$1", [failed]);
    const later = await batch('queued'); const revision = await item(later, 'Empty recap.');
    await (await import('./extraction-store.js')).applyExtraction(later,revision,'Empty recap.',[]);
    await (await import('./batches.js')).processBatch(false,true);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1', [later])).rows).toEqual([{ status: 'completed' }]);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1', [failed])).rows).toEqual([{ status: 'failed' }]);
  });
});
