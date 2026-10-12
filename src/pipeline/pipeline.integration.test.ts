import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';

const model = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('./extraction-model.js', () => ({ extractEvents: async (text: string) => {
  model.calls.push('extraction');
  return text.startsWith('Promotion:') ? [] : [{ parts: [{ start: 0, end: text.length }], context: [] }];
} }));
vi.mock('./generation-model.js', () => ({ generationClient: async () => ({
  generate: async (request: { prompt: string }) => {
    const { z } = await import('zod');
    const { modelResult } = await import('./generation.test-helpers.js');
    const input = z.object({ links: z.array(z.object({ id:z.string() })), targets:z.array(z.object({id:z.string()})) }).parse(JSON.parse(request.prompt));
    return modelResult({ associations: input.targets.flatMap(target=>input.links.map(link=>({linkId:link.id,targetId:target.id,classification:'relevant'}))) });
  },
}), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
vi.mock('./grouping-model.js', () => ({ GROUPING_VERSION: 'grouping-v1', groupReport: async (incoming: { text: string }, candidates: Array<{id:string;text:string}>) =>
  candidates.filter(candidate=>candidate.text===incoming.text).map(candidate=>({storyId:candidate.id,relation:'same'})) }));
vi.mock('../telegram/batch.js', () => ({ collectTelegramBatch: vi.fn().mockResolvedValue(0) }));
vi.mock('../models/jev.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../models/jev.js')>();
  return { ...actual, JevClient: class {
    async judge(template: string, state: { mention?: string; candidate?: string; story?: string }) {
      model.calls.push(template);
      const answer = template === 'split_validation' ? { type: 'noul', noul: 1 }
        : template === 'interest' ? { type: 'score', score: 3, probabilities: { '3': 1 }, confidence: 1, legend: {} }
        : { type: 'choice', choice: template === 'extraction_event_role' ? 'current' : template === 'event_group_integrity' ? 'coherent' : template === 'news_eligibility' ? (state.story?.startsWith('Promotion:') ? 'rejected' : 'eligible') : template === 'story_count' ? '1' : template === 'duplicate'
          ? state.mention === state.candidate ? 'same' : 'different' : template === 'representative' ? 'left' : 'relevant', probabilities: {}, confidence: 1 };
      return { answers: { answer }, metrics: {}, model: 'test', template, promptVersion: 'test' };
    }
    async close() {}
  } };
});
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  async embed() { model.calls.push('embedding'); return { vectors: [[1, 2, 3]] }; }
  async close() {}
} }));
vi.mock('./generation.js', () => ({
  researchStory: vi.fn(async (id: string, settings: AppSettings) => {
    const { loadStory, saveGenerations } = await import('./generation-store.js');
    const input = await loadStory(id);
    await saveGenerations([input], [{ id, headline: 'Новость',
      summary: input.story.chosen_excerpt, translatedExcerpt: null }], settings);
  }),
}));
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `pipeline_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let processBatch: typeof import('./batches.js').processBatch;
let cleanup: typeof import('./retention.js').cleanup;
const ids: string[] = [];
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const result = await database.db.query<{ id: string }>(sql, values);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Missing test id');
  return id;
}
async function batch(): Promise<string> {
  return one(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES(now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
}
async function item(batchId: string, text: string, old = false): Promise<string> {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,published_at) VALUES($1,'1',now()-$2*interval '1 day') RETURNING id`, [source, old ? 30 : 0]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
  ids.push(item);
  return revision;
}

describe.skipIf(!databaseUrl)('pipeline with PostgreSQL and deterministic model doubles', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl ?? '');
    url.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js');
    await database.migrate();
    const configuration = await import('../settings.js');
    settings = await configuration.saveSettings({ embeddingDimensions: 3 });
    ({ processBatch } = await import('./batches.js'));
    ({ cleanup } = await import('./retention.js'));
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('processes each item independently and resumes without repeat inference', async () => {
    const id = await batch();
    await item(id, 'Acme released a new compiler today.');
    await item(id, 'Beta released a new processor today.');
    await processBatch(true);
    expect(model.calls[0]).toBe('extraction');
    expect(model.calls.filter(call => call === 'extraction')).toHaveLength(2);
    expect(model.calls.filter(call => call === 'interest')).toHaveLength(2);
    expect(model.calls.indexOf('news_eligibility')).toBeLessThan(model.calls.indexOf('interest'));
    const stories = await database.db.query('SELECT status,headline,interest_score,summary,model_version FROM stories');
    expect(stories.rows).toHaveLength(2);
    for (const story of stories.rows) expect(story).toMatchObject({ status: 'completed', headline: 'Новость', interest_score: 4, summary: expect.any(String), model_version: settings.modelVersion });
    const count = model.calls.length;
    await processBatch(false, true);
    expect(model.calls).toHaveLength(count);
    const next = await batch();
    await item(next, 'Acme released a new compiler today.');
    await processBatch(true);
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(2);
  });
  it('persists an interrupted unknown outcome before retrying after restart', async () => {
    const id = await batch();
    const revision = await item(id, 'Gamma released a security fix.');
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,attempts) VALUES($1,$2,'extract:events-v6','running',1)`, [id, revision]);
    const count = model.calls.length;
    await processBatch(false, true);
    expect(model.calls).toHaveLength(count);
    const saved = (await database.db.query('SELECT status,next_retry_at FROM processing_batches WHERE id=$1', [id])).rows[0];
    expect(saved.status).toBe('waiting');
    expect(saved.next_retry_at.getTime()).toBeGreaterThan(Date.now());
    await processBatch(true);
    expect(model.calls).toHaveLength(count);
    await database.db.query("UPDATE processing_batches SET next_retry_at=now()-interval '1 second' WHERE id=$1", [id]);
    await database.db.query("UPDATE stage_state SET next_retry_at=now()-interval '1 second' WHERE batch_id=$1", [id]);
    await processBatch(false, true);
    expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1', [id])).rows[0].status).toBe('completed');
  });
  it('switches pending embeddings only after retained corpus is re-embedded', async () => {
    const { getActiveEmbeddingConfig, saveSettings } = await import('../settings.js');
    const { reembedPending } = await import('./vectors.js');
    const previous = await getActiveEmbeddingConfig();
    settings = await saveSettings({ embeddingInputVersion: 'next-input-v2' });
    expect((await getActiveEmbeddingConfig()).id).toBe(previous.id);
    await reembedPending(settings);
    const current = await getActiveEmbeddingConfig();
    expect(current.id).not.toBe(previous.id);
    const missing = await database.db.query(`SELECT s.id FROM stories s WHERE s.status<>'rejected'
      AND NOT EXISTS(SELECT 1 FROM embeddings e WHERE e.story_id=s.id AND e.config_id=$1)`, [current.id]);
    expect(missing.rows).toHaveLength(0);
  });
  it('recovers a digest interrupted after hiding stale story versions', async () => {
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const id = await one('SELECT id FROM stories LIMIT 1');
    await database.db.query("UPDATE stories SET status='processing' WHERE id=$1", [id]);
    await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
      [`digest_refresh:${id}`, JSON.stringify({ storyId: id })]);
    const judgments = new Judgments(settings);
    try { await refreshDigest(settings, judgments); } finally { await judgments.close(); }
    expect((await database.db.query('SELECT status,model_version,interest_stale FROM stories WHERE id=$1', [id])).rows[0])
      .toMatchObject({ status: 'completed', model_version: settings.modelVersion, interest_stale: false });
    expect((await database.db.query("SELECT key FROM operational_state WHERE key LIKE 'digest_refresh:%'")).rows).toHaveLength(0);
  });
  it('hides edited story versions atomically and cannot resurrect a withdrawn digest marker', async () => {
    const target = ids[1];
    if (!target) throw new Error('Missing original item');
    const oldStory = await one(`SELECT m.story_id AS id FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
      WHERE r.item_id=$1 LIMIT 1`, [target]);
    const id = await batch();
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,'edit-hash','Replacement release announcement.','Replacement release announcement.') RETURNING id`, [target]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [target, revision]);
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [oldStory])).rows[0].status).toBe('processing');
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [id, revision]);
    await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
      [`digest_refresh:${oldStory}`, JSON.stringify({ storyId: oldStory })]);
    await processBatch(true);
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [oldStory])).rows[0].status).toBe('rejected');
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const judgments = new Judgments(settings);
    try { await refreshDigest(settings, judgments); } finally { await judgments.close(); }
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [oldStory])).rows[0].status).toBe('rejected');
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${oldStory}`])).rows).toHaveLength(0);
  });
  it('reactivates an original revision after A -> B -> A without orphan processing stories', async () => {
    const first = await batch();
    const a = await item(first, 'Revert test A release.');
    await processBatch(true);
    const itemId = await one('SELECT item_id AS id FROM item_revisions WHERE id=$1', [a]);
    const storyA = await one('SELECT story_id AS id FROM story_mentions WHERE revision_id=$1', [a]);
    const evidence = await one(`INSERT INTO evidence_documents(url,access,expires_at,metadata)
      VALUES('https://example.org/old-primary','public',now()+interval '1 day','{"researchInputHash":"old-version"}') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,verified_at) VALUES($1,$2,'primary',now())`, [storyA, evidence]);
    const second = await batch();
    const b = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,'revert-b','Revert test B release.','Revert test B release.') RETURNING id`, [itemId]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [itemId, b]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [second, b]);
    await processBatch(true);
    const storyB = await one('SELECT story_id AS id FROM story_mentions WHERE revision_id=$1', [b]);
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [storyA])).rows[0].status).toBe('rejected');
    const third = await batch();
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [itemId, a]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [third, a]);
    await processBatch(true);
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [storyA])).rows[0].status).toBe('completed');
    expect((await database.db.query('SELECT status FROM stories WHERE id=$1', [storyB])).rows[0].status).toBe('rejected');
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [storyA])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1', [storyA])).rows).toEqual([{ evidence_id: evidence }]);
    expect((await database.db.query('SELECT id FROM evidence_documents WHERE id=$1', [evidence])).rows).toHaveLength(1);
  });
  it('atomically replaces spans and keeps committed empty output final after profile changes', async () => {
    const { applyExtraction, committedExtraction } = await import('./extraction-store.js');
    const id = await batch();
    const text = 'First release. Second release.';
    const revision = await item(id, text);
    await applyExtraction(id, revision, text, [{ start: 0, end: 14 }, { start: 15, end: text.length }]);
    const oldStories: string[] = [];
    for (const ordinal of [0, 1]) {
      const story = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
      oldStories.push(story);
      await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE revision_id=$1 AND ordinal=$3', [revision, story, ordinal]);
    }
    await applyExtraction(id, revision, text, [{ start: 0, end: text.length }]);
    expect((await database.db.query('SELECT text,story_id FROM story_mentions WHERE revision_id=$1', [revision])).rows)
      .toEqual([{ text, story_id: null }]);
    expect((await database.db.query('SELECT status FROM stories WHERE id=ANY($1::uuid[])', [oldStories])).rows)
      .toEqual([{ status: 'rejected' }, { status: 'rejected' }]);
    await applyExtraction(id, revision, text, []);
    expect(await committedExtraction(revision)).toEqual([]);
    await database.db.query("UPDATE processing_batches SET status='failed' WHERE id=$1", [id]);
    const configuration = await import('../settings.js');
    settings = await configuration.saveSettings({ interestProfile: settings.interestProfile + ' More specific.' });
    const count = model.calls.length;
    await processBatch(true);
    expect(model.calls.length).toBe(count);
    expect((await database.db.query('SELECT text FROM story_mentions WHERE revision_id=$1', [revision])).rows).toEqual([]);
  });
  it('cleans unrelated history while preserving only waiting batch/digest inputs and abandons failed digest pins', async () => {
    const expiredBatch = await batch();
    const expired = await item(expiredBatch, 'Expired unrelated release.', true);
    const pinned = await item(expiredBatch, 'Digest pinned release.', true);
    await processBatch(true);
    const pinnedStory = await one('SELECT story_id AS id FROM story_mentions WHERE revision_id=$1', [pinned]);
    await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
      [`digest_refresh:${pinnedStory}`, JSON.stringify({ storyId: pinnedStory })]);
    const waiting = await batch();
    const protectedRevision = await item(waiting, 'Waiting protected release.', true);
    await database.db.query("UPDATE processing_batches SET status='waiting',next_retry_at=now()+interval '1 hour' WHERE id=$1", [waiting]);
    await database.db.query(`INSERT INTO model_cache(kind,input_hash,model_key,prompt_version,value,expires_at)
      VALUES('judgment','expired-test','test','test','{}',now()-interval '1 day')`);
    await cleanup(settings);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [expired])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [pinned])).rows).toHaveLength(1);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [protectedRevision])).rows).toHaveLength(1);
    expect((await database.db.query("SELECT id FROM model_cache WHERE input_hash='expired-test'")).rows).toHaveLength(0);
    await database.db.query("UPDATE operational_state SET updated_at=now()-interval '30 days' WHERE key=$1", [`digest_refresh:${pinnedStory}`]);
    await database.db.query(`INSERT INTO operational_state(key,value) VALUES('pipeline_digest','{"phase":"failed"}')
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    await cleanup(settings);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [pinned])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [protectedRevision])).rows).toHaveLength(1);
    await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1", [waiting]);
  });
  it('does not expose assessed sources from prior research inputs or excerpt-only versions', async () => {
    const { loadEvidence } = await import('./generation-store.js');
    const { resetResearchFixture } = await import('./generation.test-helpers.js');
    const story = await one("INSERT INTO stories(status,summary,researched) VALUES('processing','Old summary',true) RETURNING id");
    const evidence = await one(`INSERT INTO evidence_documents(url,access,expires_at,metadata)
      VALUES('https://example.org/obsolete','public',now()+interval '1 day','{"researchInputHash":"old-input"}') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,verified_at) VALUES($1,$2,'primary',now())`, [story, evidence]);
    expect(await loadEvidence(story, 'new-input')).toEqual([]);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [story])).rows).toHaveLength(0);
    await database.db.query('UPDATE story_evidence SET superseded_at=NULL WHERE story_id=$1 AND evidence_id=$2', [story,evidence]);
    await resetResearchFixture(story);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [story])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1', [story])).rows).toHaveLength(1);
    expect((await database.db.query('SELECT summary,researched FROM stories WHERE id=$1', [story])).rows[0])
      .toMatchObject({ summary: null, researched: false });
    expect((await database.db.query('SELECT id FROM evidence_documents WHERE id=$1', [evidence])).rows).toHaveLength(1);
  });
  it('invalidates research and primary assessments when a hidden link changes without text edits', async () => {
    const first = await batch();
    const text = 'Hidden link regression release.';
    const revision = await item(first, text);
    const itemId = await one('SELECT item_id AS id FROM item_revisions WHERE id=$1', [revision]);
    await database.db.query(`INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,'https://example.org/announcement','Source')`, [revision]);
    await processBatch(true);
    const story = await one('SELECT story_id AS id FROM story_mentions WHERE revision_id=$1', [revision]);
    const before = (await database.db.query<{ content_version: number }>('SELECT content_version FROM stories WHERE id=$1', [story])).rows[0];
    await database.db.query("UPDATE stories SET summary='Obsolete summary',researched=true WHERE id=$1", [story]);
    const evidence = await one(`INSERT INTO evidence_documents(url,access,expires_at)
      VALUES('https://example.org/announcement','public',now()+interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,verified_at) VALUES($1,$2,'primary',now())`, [story, evidence]);
    const second = await batch();
    const edited = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,'hidden-link-edit',$2,$2) RETURNING id`, [itemId, text]);
    await database.db.query(`INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,'https://example.org/correction','Source')`, [edited]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [itemId, edited]);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [second, edited]);
    await processBatch(true);
    const after = (await database.db.query<{ content_version: number; summary: string | null }>('SELECT content_version,summary FROM stories WHERE id=$1', [story])).rows[0];
    expect(after?.content_version).toBeGreaterThan(before?.content_version ?? 0);
    expect(after?.summary).toBe('Hidden link regression release.');
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [story])).rows).toHaveLength(0);
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1', [story])).rows).toEqual([{ evidence_id: evidence }]);
  });
  it('rejects promotions before interest and refreshes historical eligibility independently of score', async () => {
    const id = await batch();
    const revision = await item(id, 'Promotion: register for our new AI course and webinar.');
    await processBatch(true);
    expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1 AND revision_id=$2', [id, revision])).rows[0].status).toBe('rejected');
    expect((await database.db.query('SELECT id FROM story_mentions WHERE revision_id=$1', [revision])).rows).toHaveLength(0);
    const story = await one(`INSERT INTO stories(status,chosen_excerpt) VALUES('completed','Promotion: register for our new AI course and webinar.') RETURNING id`);
    await database.db.query(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,'Promotion: register for our new AI course and webinar.',0)`, [revision, story]);
    expect((await database.db.query("SELECT id FROM judgments WHERE story_id=$1 AND stage='interest'", [story])).rows).toHaveLength(0);
    await database.db.query("DELETE FROM judgments WHERE story_id=$1 AND stage='eligibility'", [story]);
    await database.db.query(`UPDATE stories SET status='completed',headline='Old promotional headline',interest_score=1,
      interest_stale=false,profile_version=$2,model_version=$3 WHERE id=$1`, [story, settings.profileVersion, settings.modelVersion]);
    const { refreshDigest } = await import('./stories.js');
    const { guardDigestEligibility } = await import('./eligibility.js');
    const { Judgments } = await import('./judgments.js');
    await guardDigestEligibility(settings);
    expect((await database.db.query('SELECT interest_stale FROM stories WHERE id=$1', [story])).rows[0].interest_stale).toBe(true);
    const judge = new Judgments(settings);
    try { await refreshDigest(settings, judge); } finally { await judge.close(); }
    expect((await database.db.query('SELECT status,interest_stale FROM stories WHERE id=$1', [story])).rows[0])
      .toMatchObject({ status: 'rejected', interest_stale: false });
    const configuration = await import('../settings.js');
    settings = await configuration.saveSettings({ interestProfile: settings.interestProfile + ' Exclude invitations.' });
    const nextJudge = new Judgments(settings);
    try { await refreshDigest(settings, nextJudge); } finally { await nextJudge.close(); }
    expect((await database.db.query('SELECT profile_version,status FROM stories WHERE id=$1', [story])).rows[0])
      .toMatchObject({ profile_version: settings.profileVersion, status: 'rejected' });
  });
  it('retains active history and preserves detached publication snapshots after cleanup', async () => {
    const id = await batch();
    const revision = await item(id, 'Old story released.', true);
    await cleanup(settings);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [revision])).rows).toHaveLength(1);
    await processBatch(true);
    const story = await one('SELECT story_id AS id FROM story_mentions WHERE revision_id=$1', [revision]);
    const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
      [story, JSON.stringify({ headline: 'Архив', score: 4, details: 'Текст', detailsKind: 'excerpt', sources: [] })]);
    await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,callback_id,status)
      VALUES($1,$2,'test','1',$3,'published')`, [story, snapshot, randomUUID()]);
    await cleanup(settings);
    expect((await database.db.query('SELECT id FROM item_revisions WHERE id=$1', [revision])).rows).toHaveLength(0);
    const publication = (await database.db.query('SELECT story_id,snapshot_id FROM publications WHERE snapshot_id=$1', [snapshot])).rows[0];
    expect(publication.story_id).toBeNull();
    expect((await database.db.query('SELECT content FROM publication_snapshots WHERE id=$1', [snapshot])).rows[0].content.headline).toBe('Архив');
  });
});
