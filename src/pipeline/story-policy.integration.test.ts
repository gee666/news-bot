import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ generated: [] as Array<{ id: string; modelVersion: number }>, clock: 0, overrun: false }));
vi.mock('./collection.js', () => ({ collectBatch: async () => {} }));
vi.mock('../models/jev.js', async original => ({ ...await original<typeof import('../models/jev.js')>(), JevClient: class {
  async judge(template: string) {
    const answer = template==='interest' ? { type: 'score', score: 8, probabilities: { '7': 1 }, confidence: 1, legend: {} }
      : { type: 'choice', choice: template==='representative' ? 'left' : template==='event_group_integrity' ? 'coherent'
        : template==='duplicate' ? 'different' : 'eligible', probabilities: {}, confidence: 1 };
    return { answers: { answer }, metrics: {}, model: 'offline' };
  }
  async close() {}
} }));
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  async embed() { return { vectors: [[1,2,3]] }; }
  async close() {}
} }));
vi.mock('./generation.js', () => ({ researchStory: async (id: string, settings: AppSettings) => {
  const { loadStory, saveGenerations } = await import('./generation-store.js'); const input = await loadStory(id);
  await saveGenerations([input], [{ id, headline: 'Новость', summary: `Подробности модели ${settings.modelVersion}`, translatedExcerpt: null }], settings);
  mocks.generated.push({ id, modelVersion: settings.modelVersion });
  if (settings.modelVersion===2 || mocks.overrun) mocks.clock=1001;
} }));
const url = process.env.TEST_DATABASE_URL;
const schema = `story_policy_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let old: AppSettings;
let current: AppSettings;
let judgments: import('./judgments.js').Judgments;
let vectors: import('./vectors.js').Vectors;
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql,args)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture'); return id;
}
async function batch(): Promise<string> {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(old),old.profileVersion,old.modelVersion]);
}
async function item(batchId: string, text: string, storyId = randomUUID()) {
  const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test','public') RETURNING id", [randomUUID()]);
  const id = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'1') RETURNING id", [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [id,randomUUID(),text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [id,revision]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId,revision]);
  await (await import('./extraction-store.js')).applyExtraction(batchId,revision,text,[{start:0,end:text.length}]);
  const story = await one("INSERT INTO stories(id,status,chosen_excerpt) VALUES($1,'processing',$2) RETURNING id", [storyId,text]);
  await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE revision_id=$1', [revision,story]);
  return { story, revision, text };
}
describe.skipIf(!url)('old batch and newer digest policy', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS','3');
    database = await import('../db.js'); await database.migrate();
    const settings = await import('../settings.js'); const base = await settings.saveSettings({ embeddingDimensions: 3 });
    old = { ...base, modelVersion: 2 }; current = { ...base, modelVersion: 3 };
    await database.db.query('UPDATE app_settings SET value=$1 WHERE id=1', [JSON.stringify(current)]);
    judgments = new (await import('./judgments.js')).Judgments(old);
    vectors = new (await import('./vectors.js')).Vectors(await settings.getActiveEmbeddingConfig(),old);
  });
  beforeEach(async () => {
    mocks.generated.length=0; mocks.clock=0; mocks.overrun=false;
    await database.db.query('TRUNCATE sources,stories,processing_batches,model_cache CASCADE');
    await database.db.query('DELETE FROM operational_state');
  });
  afterAll(async () => {
    await judgments?.close(); await vectors?.close(); await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  it('advances past newer completed stories across repeated old-batch slices without downgrading them or their ready events', async () => {
    const batchId = await batch(); const first = await item(batchId,'First release.'); const sibling = await item(batchId,'Second release.');
    const { finishBatchStories, refreshDigest } = await import('./stories.js');
    const newerJudgments = new (await import('./judgments.js')).Judgments(current);
    await finishBatchStories(batchId,old,judgments,vectors,undefined,[first.story]);
    await refreshDigest(current,newerJudgments,[first.story]);
    const ready = (await database.db.query('SELECT * FROM story_publication_ready WHERE story_id=$1', [first.story])).rows;
    const prior = (await database.db.query("SELECT * FROM judgments WHERE story_id=$1 AND stage='generation_research' ORDER BY id", [first.story])).rows;
    const previous = process.env.PROCESSING_SLICE_MS;
    vi.stubEnv('PROCESSING_SLICE_MS','1000'); const now = vi.spyOn(performance,'now').mockImplementation(() => mocks.clock);
    mocks.clock=0;
    try {
      const { processBatch } = await import('./batches.js');
      await processBatch(false,true);
      expect((await database.db.query('SELECT model_version FROM stories WHERE id=$1', [first.story])).rows).toEqual([{model_version:3}]);
      expect((await database.db.query('SELECT headline,model_version FROM stories WHERE id=$1', [sibling.story])).rows)
        .toEqual([{headline:'Новость',model_version:2}]);
      expect((await database.db.query('SELECT * FROM story_publication_ready WHERE story_id=$1', [first.story])).rows).toEqual(ready);
      expect((await database.db.query("SELECT * FROM judgments WHERE story_id=$1 AND stage='generation_research' ORDER BY id", [first.story])).rows).toEqual(prior);
      await refreshDigest(current,newerJudgments,[sibling.story]);
      const generated = [...mocks.generated];
      await database.db.query(`INSERT INTO stage_state(batch_id,story_id,stage,status,next_retry_at)
        VALUES($1,$2,'research:legacy-m2','waiting',now()+interval '1 hour')`, [batchId,first.story]);
      await database.db.query('UPDATE processing_batches SET next_retry_at=now()-interval \'1 second\' WHERE id=$1', [batchId]);
      await processBatch(false,true);
      expect(mocks.generated).toEqual(generated);
      expect((await database.db.query('SELECT model_version FROM stories WHERE id=ANY($1::uuid[])', [[first.story,sibling.story]])).rows)
        .toEqual([{model_version:3},{model_version:3}]);
      expect((await database.db.query('SELECT status,settings_snapshot FROM processing_batches WHERE id=$1', [batchId])).rows)
        .toEqual([{status:'completed',settings_snapshot:old}]);
      expect((await database.db.query("SELECT status,next_retry_at FROM stage_state WHERE batch_id=$1 AND stage='research:legacy-m2'", [batchId])).rows)
        .toEqual([{status:'skipped',next_retry_at:null}]);
    } finally {
      now.mockRestore(); await newerJudgments.close();
      if (previous === undefined) delete process.env.PROCESSING_SLICE_MS; else process.env.PROCESSING_SLICE_MS=previous;
    }
  });
  it('keeps completed batch items and newer story output unchanged when replaying identical extraction', async () => {
    const batchId = await batch(); const value = await item(batchId,'Unchanged release.');
    const newerJudgments = new (await import('./judgments.js')).Judgments(current);
    try { await (await import('./stories.js')).refreshDigest(current,newerJudgments,[value.story]); } finally { await newerJudgments.close(); }
    await database.db.query("UPDATE batch_items SET status='completed' WHERE batch_id=$1 AND revision_id=$2", [batchId,value.revision]);
    const story = (await database.db.query('SELECT * FROM stories WHERE id=$1', [value.story])).rows;
    await (await import('./extraction-store.js')).applyExtraction(batchId,value.revision,value.text,[{start:0,end:value.text.length}]);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,value.revision])).rows)
      .toEqual([{status:'completed'}]);
    expect((await database.db.query('SELECT * FROM stories WHERE id=$1', [value.story])).rows).toEqual(story);
    await (await import('./extraction-store.js')).applyExtraction(batchId,value.revision,value.text,[{start:0,end:value.text.length-1}]);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [batchId,value.revision])).rows)
      .toEqual([{status:'processing'}]);
  });
  it('refreshes a legacy notice before lower UUIDs when only one story fits the slice', async () => {
    const batchId = await batch();
    const ordinary = await item(batchId,'Ordinary release.','00000000-0000-4000-8000-000000000010');
    const notice = await item(batchId,'Legacy news.','ffffffff-ffff-4fff-8fff-ffffffffffff');
    await database.db.query(`UPDATE stories SET status='completed',headline='Материалы по новости',
      summary='Краткий пересказ недоступен. Ссылки ниже.',researched=true,interest_score=8,interest_stale=false,
      profile_version=$2,model_version=$3 WHERE id=$1`, [notice.story,current.profileVersion,current.modelVersion]);
    const newerJudgments = new (await import('./judgments.js')).Judgments(current);
    const previous = process.env.PROCESSING_SLICE_MS; process.env.PROCESSING_SLICE_MS='1000';
    const now = vi.spyOn(performance,'now').mockImplementation(() => mocks.clock); mocks.overrun=true;
    try {
      const { withProcessingSlice, ProcessingYield } = await import('./processing-slice.js');
      const { refreshDigest } = await import('./stories.js');
      await expect(withProcessingSlice(() => refreshDigest(current,newerJudgments,[ordinary.story,notice.story])))
        .rejects.toBeInstanceOf(ProcessingYield);
      expect(mocks.generated).toEqual([{id:notice.story,modelVersion:3}]);
      expect((await database.db.query('SELECT summary FROM stories WHERE id=$1', [notice.story])).rows)
        .toEqual([{summary:'Подробности модели 3'}]);
      expect((await database.db.query('SELECT headline FROM stories WHERE id=$1', [ordinary.story])).rows)
        .toEqual([{headline:null}]);
    } finally {
      now.mockRestore(); await newerJudgments.close();
      if (previous===undefined) delete process.env.PROCESSING_SLICE_MS; else process.env.PROCESSING_SLICE_MS=previous;
    }
  });
  it('keeps the old snapshot semantics for unfinished work rather than treating stale newer fields as completed output', async () => {
    const batchId = await batch(); const value = await item(batchId,'Pending release.');
    const newerJudgments = new (await import('./judgments.js')).Judgments(current);
    const { refreshDigest, finishBatchStories } = await import('./stories.js');
    try { await refreshDigest(current,newerJudgments,[value.story]); } finally { await newerJudgments.close(); }
    await database.db.query("UPDATE stories SET status='processing',interest_stale=true WHERE id=$1", [value.story]);
    const generated = mocks.generated.length;
    await finishBatchStories(batchId,old,judgments,vectors,undefined,[value.story]);
    expect(mocks.generated.slice(generated)).toEqual([{id:value.story,modelVersion:2}]);
    expect((await database.db.query('SELECT status,model_version FROM stories WHERE id=$1', [value.story])).rows)
      .toEqual([{status:'completed',model_version:2}]);
    expect((await database.db.query('SELECT settings_snapshot FROM processing_batches WHERE id=$1', [batchId])).rows)
      .toEqual([{settings_snapshot:old}]);
  });
});
