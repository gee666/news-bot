import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ generated: 0, judged: 0 }));
vi.mock('../models/jev.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../models/jev.js')>();
  return { ...actual, JevClient: class {
    async judge(template: string) {
      mocks.judged++;
      const answer = template === 'interest' ? { type: 'score', score: 3, probabilities: { '3': 1 }, confidence: 1, legend: {} }
        : { type: 'choice', choice: template === 'event_group_integrity' ? 'coherent' : template === 'representative' ? 'right' : 'eligible', probabilities: {}, confidence: 1 };
      return { answers: { answer }, metrics: {}, model: 'test' };
    }
    async close() {}
  } };
});
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  async embed() { return { vectors: [[1, 2, 3]] }; }
  async close() {}
} }));
vi.mock('./generation.js', () => ({ researchStory: vi.fn(async (id: string, settings: AppSettings) => {
  mocks.generated++;
  const { loadStory, saveGenerations } = await import('./generation-store.js');
  const input = await loadStory(id);
  await saveGenerations([input], [{ id, headline: 'Актуальный заголовок',
    summary: 'Актуальные подробности', translatedExcerpt: null }], settings);
}) }));
const url = process.env.TEST_DATABASE_URL;
const schema = `generation_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let generationVersion: string;
let storyId: string;
let batchId: string;
const detailed = 'Acme released an API for routing requests and returning confidence scores.';
async function one(sql: string, args: unknown[] = []) {
  const result = await database.db.query<{ id: string }>(sql, args);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Missing fixture id');
  return id;
}
describe.skipIf(!url)('current editorial generation integration', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    generationVersion = (await import('./generation-store.js')).GENERATION_VERSION;
    settings = await (await import('../settings.js')).getSettings();
    batchId = await one(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES(now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
    storyId = await one(`INSERT INTO stories(status,chosen_excerpt,headline,translated_excerpt,interest_score,interest_stale,profile_version,model_version)
      VALUES('completed','API launched.','Старый заголовок','API launched.',4,false,$1,$2) RETURNING id`, [settings.profileVersion, settings.modelVersion]);
    const config = await (await import('../settings.js')).getActiveEmbeddingConfig();
    await database.db.query(`INSERT INTO embeddings(config_id,story_id,input_hash,embedding) VALUES($1,$2,'obsolete','[9,0,1]')`, [config.id, storyId]);
    const evidence = await one(`INSERT INTO evidence_documents(url,access,expires_at) VALUES('https://example.org/old','public',now()+interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,verified_at) VALUES($1,$2,'primary',now())`, [storyId, evidence]);
    const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed','editorial','Editorial','public') RETURNING id");
    for (const [index, text] of ['API launched.', detailed].entries()) {
      const item = await one('INSERT INTO source_items(source_id,external_id) VALUES($1,$2) RETURNING id', [source, String(index)]);
      const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
        VALUES($1,1,$2,$3,$3) RETURNING id`, [item, String(index), text]);
      await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
      await database.db.query('INSERT INTO story_mentions(revision_id,story_id,text,ordinal,created_at) VALUES($1,$2,$3,0,now()+$4*interval \'1 second\')', [revision, storyId, text, index]);
      await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
    }
    await database.db.query(`INSERT INTO stage_state(batch_id,story_id,stage,status,output) VALUES($1,$2,'representative:v1:p1:m1','completed','"API launched."')`, [batchId, storyId]);
    await database.db.query(`INSERT INTO judgments(story_id,stage,input_hash,model_key,prompt_version,result,expires_at)
      VALUES($1,'generation_headline','old',$2,'generation-v1',$3,now()+interval '1 day')`,
    [storyId, `${settings.piProvider}/${settings.piModel}`, JSON.stringify({ headline: 'Старый заголовок', summary: null, translatedExcerpt: 'API launched.' })]);
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('refreshes completed v1 output through representative-v3 and current generation persisted stages', async () => {
    const { finishBatchStories } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const { Vectors } = await import('./vectors.js');
    const { getActiveEmbeddingConfig } = await import('../settings.js');
    const { generationIsCurrent } = await import('./generation-freshness.js');
    const judgments = new Judgments(settings); const vectors = new Vectors(await getActiveEmbeddingConfig(), settings);
    try { await finishBatchStories(batchId, settings, judgments, vectors); } finally { await judgments.close(); await vectors.close(); }
    const row = (await database.db.query('SELECT chosen_excerpt,status,content_version,interest_stale FROM stories WHERE id=$1', [storyId])).rows[0];
    expect(row).toMatchObject({ chosen_excerpt: detailed, status: 'completed', content_version: 2, interest_stale: false });
    const stages = (await database.db.query<{ stage: string }>('SELECT stage FROM stage_state WHERE story_id=$1', [storyId])).rows.map(row => row.stage);
    expect(stages).toEqual(['representative:v1:p1:m1']);
    expect(mocks.generated).toBe(1);
    expect(await generationIsCurrent(storyId, settings)).toBe(true);
    expect((await database.db.query('SELECT embedding::text AS vector FROM embeddings WHERE story_id=$1', [storyId])).rows).toEqual([{ vector: '[1,2,3]' }]);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [storyId])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NOT NULL', [storyId])).rows).toHaveLength(1);
  });
  it('does not let completed stage receipts bypass expired generation on a resumed batch', async () => {
    const receipts = await database.db.query(`SELECT stage FROM stage_state WHERE batch_id=$1 AND story_id=$2
      AND status='completed' AND stage LIKE 'research:%'`, [batchId, storyId]);
    expect(receipts.rows).toHaveLength(0);
    const expired = await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE story_id=$1 AND prompt_version=$2",
      [storyId, generationVersion]);
    expect(expired.rowCount).toBeGreaterThan(0);
    expect(await (await import('./generation-freshness.js')).generationIsCurrent(storyId, settings)).toBe(false);
    const { researchStory } = await import('./generation.js');
    const researchCalls = vi.mocked(researchStory).mock.calls.length;
    const { finishBatchStories } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const { Vectors } = await import('./vectors.js');
    const { getActiveEmbeddingConfig } = await import('../settings.js');
    const judgments = new Judgments(settings); const vectors = new Vectors(await getActiveEmbeddingConfig(), settings);
    const calls = mocks.generated;
    try { await finishBatchStories(batchId, settings, judgments, vectors); } finally { await judgments.close(); await vectors.close(); }
    expect(mocks.generated).toBe(calls + 1);
    expect(researchStory).toHaveBeenCalledTimes(researchCalls + 1);
    expect(await (await import('./generation-freshness.js')).generationIsCurrent(storyId, settings)).toBe(true);
  });
  it.each(['stale rank', 'expired rank', 'wrong rank model', 'expired eligibility', 'wrong eligibility model', 'source association'] as const)(
    'repairs completed checkpoint receipts after %s without another JEV request', async mutation => {
      const { finishBatchStories } = await import('./stories.js');
      const { Judgments } = await import('./judgments.js');
      const { Vectors } = await import('./vectors.js');
      const { getActiveEmbeddingConfig } = await import('../settings.js');
      const { generationIsCurrent } = await import('./generation-freshness.js');
      const judgments = new Judgments(settings); const vectors = new Vectors(await getActiveEmbeddingConfig(), settings);
      const receipts = (await database.db.query<{ id: string; stage: string; attempts: number }>(`SELECT id,stage,attempts
        FROM stage_state WHERE batch_id=$1 AND story_id=$2 AND status='completed'
          AND (stage LIKE 'interest:%' OR stage LIKE 'news-eligibility-v3:%')`, [batchId, storyId])).rows;
      expect(receipts).toHaveLength(0);
      const cache = (await database.db.query("SELECT * FROM model_cache WHERE kind='judgment' ORDER BY id")).rows;
      const judged = mocks.judged;
      if (mutation.startsWith('expired')) {
        await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE story_id=$1 AND stage=$2",
          [storyId, mutation.includes('eligibility') ? 'eligibility' : 'interest']);
      } else if (mutation.startsWith('wrong')) {
        await database.db.query("UPDATE judgments SET model_key='other/model' WHERE story_id=$1 AND stage=$2",
          [storyId, mutation.includes('eligibility') ? 'eligibility' : 'interest']);
      } else {
        await database.db.query("UPDATE stories SET status='processing',interest_stale=true WHERE id=$1", [storyId]);
        if (mutation === 'source association') {
          const revision = (await database.db.query<{ revision_id: string }>('SELECT revision_id FROM story_mentions WHERE story_id=$1 LIMIT 1', [storyId])).rows[0];
          if (!revision) throw new Error('Missing current revision');
          const link = await one(`INSERT INTO item_links(revision_id,url,anchor_text)
            VALUES($1,'https://example.org/association','Report') RETURNING id`, [revision.revision_id]);
          await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
            VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [link, storyId]);
        }
      }
      try { await finishBatchStories(batchId, settings, judgments, vectors); }
      finally { await judgments.close(); await vectors.close(); }
      expect((await database.db.query('SELECT status,interest_stale FROM stories WHERE id=$1', [storyId])).rows)
        .toEqual([{ status: 'completed', interest_stale: false }]);
      expect(await generationIsCurrent(storyId, settings)).toBe(true);
      expect(mocks.judged).toBe(judged);
      expect((await database.db.query("SELECT * FROM model_cache WHERE kind='judgment' ORDER BY id")).rows).toEqual(cache);
      for (const receipt of receipts) {
        expect((await database.db.query('SELECT status,attempts FROM stage_state WHERE id=$1', [receipt.id])).rows)
          .toEqual([{ status: 'completed', attempts: receipt.attempts }]);
      }
      expect((await database.db.query('SELECT id,settings_snapshot FROM processing_batches WHERE id=$1', [batchId])).rows)
        .toEqual([{ id: batchId, settings_snapshot: settings }]);
    });
  it('repairs rank after a real checkpoint while an independent story keeps its current generation', async () => {
    const { finishBatchStories } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const { Vectors } = await import('./vectors.js');
    const { getActiveEmbeddingConfig } = await import('../settings.js');
    const { withProcessingSlice } = await import('./processing-slice.js');
    const source = await one('SELECT id FROM sources LIMIT 1');
    const peer = await one("INSERT INTO stories(chosen_excerpt) VALUES('Independent laboratory released a public dataset.') RETURNING id");
    const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'independent') RETURNING id", [source]);
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,1,'independent','Independent laboratory released a public dataset.','Independent laboratory released a public dataset.') RETURNING id`, [item]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
    await database.db.query("INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,'Independent laboratory released a public dataset.',0)", [revision, peer]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
    const judgments = new Judgments(settings); const vectors = new Vectors(await getActiveEmbeddingConfig(), settings);
    try {
      await finishBatchStories(batchId, settings, judgments, vectors);
      const peerReceipts = (await database.db.query('SELECT * FROM stage_state WHERE story_id=$1 ORDER BY id', [peer])).rows;
      const ownRevision = (await database.db.query<{ revision_id: string }>('SELECT revision_id FROM story_mentions WHERE story_id=$1 LIMIT 1', [storyId])).rows[0];
      if (!ownRevision) throw new Error('Missing current revision');
      const link = await one("INSERT INTO item_links(revision_id,url) VALUES($1,'https://example.org/checkpoint') RETURNING id", [ownRevision.revision_id]);
      await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
        VALUES($1,$2,'relevant','fixture',1,'fixture','checkpoint')`, [link, storyId]);
      await database.db.query("UPDATE stories SET status='processing',interest_stale=true WHERE id=$1", [storyId]);
      const originalSlice = process.env.PROCESSING_SLICE_MS;
      vi.stubEnv('PROCESSING_SLICE_MS', '1000');
      let clock = 0;
      const clockSpy = vi.spyOn(performance, 'now').mockImplementation(() => clock);
      const original = judgments.judge.bind(judgments);
      const judgeSpy = vi.spyOn(judgments, 'judge').mockImplementation(async (...args) => {
        const result = await original(...args); if (args[0] === 'interest') clock = 1001; return result;
      });
      await withProcessingSlice(async () => { await finishBatchStories(batchId, settings, judgments, vectors); });
      judgeSpy.mockRestore(); clockSpy.mockRestore(); vi.stubEnv('PROCESSING_SLICE_MS', originalSlice);
      await database.db.query("UPDATE stories SET interest_stale=true WHERE id=$1", [storyId]);
      const judged = mocks.judged;
      await withProcessingSlice(async () => { await finishBatchStories(batchId, settings, judgments, vectors); });
      expect(mocks.judged).toBe(judged);
      expect((await database.db.query('SELECT status,interest_stale FROM stories WHERE id=$1', [storyId])).rows)
        .toEqual([{ status: 'completed', interest_stale: false }]);
      expect((await database.db.query('SELECT * FROM stage_state WHERE story_id=$1 ORDER BY id', [peer])).rows).toEqual(peerReceipts);
    } finally { await judgments.close(); await vectors.close(); }
  });
  it('keeps expired, wrong-model and output-mismatched displays non-current until refresh repairs them', async () => {
    const { generationIsCurrent } = await import('./generation-freshness.js');
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const expired = await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE story_id=$1 AND prompt_version=$2",
      [storyId, generationVersion]);
    expect(expired.rowCount).toBeGreaterThan(0);
    expect(await generationIsCurrent(storyId, settings)).toBe(false);
    const judgments = new Judgments(settings);
    try {
      await refreshDigest(settings, judgments);
      expect(await generationIsCurrent(storyId, settings)).toBe(true);
      const calls = mocks.generated;
      await refreshDigest(settings, judgments);
      expect(mocks.generated).toBe(calls);
      const mismatched = await database.db.query("UPDATE judgments SET model_key='other/model' WHERE story_id=$1 AND prompt_version=$2",
        [storyId, generationVersion]);
      expect(mismatched.rowCount).toBeGreaterThan(0);
      expect(await generationIsCurrent(storyId, settings)).toBe(false);
      await refreshDigest(settings, judgments);
      expect(await generationIsCurrent(storyId, settings)).toBe(true);
      await database.db.query("UPDATE stories SET headline='Несоответствующий заголовок' WHERE id=$1", [storyId]);
      expect(await generationIsCurrent(storyId, settings)).toBe(false);
    } finally { await judgments.close(); }
  });
  it('limits an explicit editorial correction to the requested stories', async () => {
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const { generationIsCurrent } = await import('./generation-freshness.js');
    const judgments = new Judgments(settings);
    const calls = mocks.generated;
    await database.db.query("UPDATE stories SET status='processing' WHERE id=$1", [storyId]);
    await database.db.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${storyId}`]);
    try {
      await refreshDigest(settings, judgments, []);
      await refreshDigest(settings, judgments, [randomUUID()]);
      expect(mocks.generated).toBe(calls);
      expect(await generationIsCurrent(storyId, settings)).toBe(false);
      await refreshDigest(settings, judgments, [storyId]);
      expect(mocks.generated).toBe(calls + 1);
      expect(await generationIsCurrent(storyId, settings)).toBe(true);
      await expect(refreshDigest(settings, judgments, ['not-an-id'])).rejects.toThrow();
    } finally { await judgments.close(); }
  });
  it('accepts a current Pi fallback ranking receipt without weakening freshness',async ()=>{
    const {refreshDigest}=await import('./stories.js'); const {Judgments}=await import('./judgments.js');
    const judgments=new Judgments(settings);
    try {await refreshDigest(settings,judgments,[storyId]);} finally {await judgments.close();}
    await database.db.query("UPDATE judgments SET model_key=$2 WHERE story_id=$1 AND stage='interest'",[storyId,`${settings.piProvider}/${settings.piModel}`]);
    const {storyPostconditions}=await import('./story-postconditions.js');
    expect((await storyPostconditions(storyId,settings)).rankingCurrent).toBe(true);
    await database.db.query("UPDATE judgments SET model_key='unrelated/model' WHERE story_id=$1 AND stage='interest'",[storyId]);
    expect((await storyPostconditions(storyId,settings)).rankingCurrent).toBe(false);
  });
  it('automatically regenerates a hardcoded notice on ordinary digest refresh', async () => {
    const { loadStory, saveGenerations } = await import('./generation-store.js');
    const { generationIsCurrent } = await import('./generation-freshness.js');
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    await database.db.query("UPDATE stories SET status='completed' WHERE id=$1", [storyId]);
    const input = await loadStory(storyId);
    await saveGenerations([input], [{ id: storyId, headline: 'Материалы по новости',
      summary: 'Краткий пересказ недоступен. Ссылки ниже.', translatedExcerpt: null }], settings);
    expect(await generationIsCurrent(storyId, settings)).toBe(false);
    const generated = mocks.generated;
    const judgments = new Judgments(settings);
    try { await refreshDigest(settings, judgments); } finally { await judgments.close(); }
    expect(mocks.generated).toBe(generated + 1);
    expect(await generationIsCurrent(storyId, settings)).toBe(true);
    expect((await database.db.query('SELECT summary FROM stories WHERE id=$1', [storyId])).rows[0]?.summary).toBe('Актуальные подробности');
  });
  it('refreshes the newest digest story first and retains its receipt across checkpoints', async () => {
    const ids = [randomUUID(), randomUUID()].sort(); const source = await one('SELECT id FROM sources LIMIT 1');
    for (const [index, id] of ids.entries()) {
      const text = `Scoped event ${index}`;
      await database.db.query("INSERT INTO stories(id,status,chosen_excerpt) VALUES($1,'processing',$2)", [id,text]);
      const item = await one("INSERT INTO source_items(source_id,external_id,collected_at) VALUES($1,$2,now()-$3*interval '1 hour') RETURNING id", [source,id,2-index]);
      const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
        VALUES($1,1,$2,$3,$3) RETURNING id`, [item,id,text]);
      await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item,revision]);
      await database.db.query('INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,$3,0)', [id,revision,text]);
    }
    const { refreshDigest } = await import('./stories.js'); const { researchStory } = await import('./generation.js');
    const { Judgments } = await import('./judgments.js'); const { withProcessingSlice, ProcessingYield } = await import('./processing-slice.js');
    const generate = vi.mocked(researchStory).getMockImplementation(); if (!generate) throw new Error('Missing generator fixture');
    const previous = process.env.PROCESSING_SLICE_MS; process.env.PROCESSING_SLICE_MS = '1000';
    let clock = 0; const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.mocked(researchStory).mockImplementation(async (...args) => { const result = await generate(...args); clock = 1001; return result; });
    const judgments = new Judgments(settings);
    try {
      await expect(withProcessingSlice(() => refreshDigest(settings, judgments, ids))).rejects.toBeInstanceOf(ProcessingYield);
      expect((await database.db.query('SELECT id,status FROM stories WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])).rows)
        .toEqual([{ id: ids[0], status: 'processing' }, { id: ids[1], status: 'completed' }]);
      expect((await database.db.query('SELECT story_id FROM story_publication_ready WHERE story_id=ANY($1::uuid[])', [ids])).rows)
        .toEqual([{ story_id: ids[1] }]);
      expect((await database.db.query("SELECT key FROM operational_state WHERE key=ANY($1::text[])", [ids.map(id => `pipeline_failed_story:${id}`)])).rows).toEqual([]);
      const receipts = (await database.db.query("SELECT * FROM judgments WHERE story_id=$1 AND stage='generation_research'", [ids[1]])).rows;
      await withProcessingSlice(() => refreshDigest(settings, judgments, ids));
      expect((await database.db.query("SELECT * FROM judgments WHERE story_id=$1 AND stage='generation_research'", [ids[1]])).rows).toEqual(receipts);
      expect((await database.db.query('SELECT story_id FROM story_publication_ready WHERE story_id=ANY($1::uuid[])', [ids])).rows).toHaveLength(2);
    } finally {
      await judgments.close(); now.mockRestore(); vi.mocked(researchStory).mockImplementation(generate);
      if (previous === undefined) delete process.env.PROCESSING_SLICE_MS; else process.env.PROCESSING_SLICE_MS = previous;
    }
  });
  it('detects changed supporting input even when content version and stored display fields still match', async () => {
    const { generationIsCurrent } = await import('./generation-freshness.js');
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const judgments = new Judgments(settings);
    try { await refreshDigest(settings, judgments); } finally { await judgments.close(); }
    expect(await generationIsCurrent(storyId, settings)).toBe(true);
    const mention = (await database.db.query<{ id: string; revision_id: string }>('SELECT id,revision_id FROM story_mentions WHERE story_id=$1 LIMIT 1', [storyId])).rows[0];
    if (!mention) throw new Error('Missing fixture mention');
    const link = await one(`INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,'https://example.org/correction','Source') RETURNING id`, [mention.revision_id]);
    await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')`, [mention.id, link]);
    expect(await generationIsCurrent(storyId, settings)).toBe(false);
  });
});
