import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import { jevTemplates } from '../models/templates.js';
const url = process.env.TEST_DATABASE_URL;
const schema = `ready_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let ready: typeof import('./ready.js');
let store: typeof import('./store.js');
let settings: import('../settings.js').AppSettings;
let serial = 0;
async function one(sql: string, values: unknown[] = []) {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function batch(manualId?: string) {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,manual_operation_id)
    VALUES('processing',now(),$1,$2,$3,$4) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion, manualId ?? null]);
}
async function story(batchId: string) {
  const label = `Ready ${++serial}`;
  const id = await one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,'Accepted details',$1,8,true,false,$2,$3) RETURNING id`, [label, settings.profileVersion, settings.modelVersion]);
  const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Fixture','public') RETURNING id", [label]);
  const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'entry') RETURNING id", [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$2,$2) RETURNING id`, [item, label]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  await database.db.query('INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,$3,0)', [id, revision, label]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
  await acceptFixtureStories(settings, [id]);
  await database.db.query(`INSERT INTO judgments(story_id,stage,input_hash,model_key,prompt_version,profile_version,model_version,result,expires_at)
    SELECT id,'eligibility','fixture','fixture',$2,$3,$4,jsonb_build_object('eligible',true,'contentVersion',content_version),now()+interval '7 days'
    FROM stories WHERE id=$1`, [id, jevTemplates.news_eligibility.version, settings.profileVersion, settings.modelVersion]);
  return id;
}
async function sourceCorrection(storyId: string) {
  const evidence=await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
    VALUES('https://new.example/report','New source','Read report details','public',now()+interval '1 day') RETURNING id`);
  await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[storyId,evidence]);
}
async function enqueue(id: string, batchId: string | null) {
  await database.transaction(client => ready.enqueueReadyStory(client, id, settings, batchId));
}
async function deferPair(leftId: string, rightId: string) {
  const { eventInput } = await import('../pipeline/consolidation-input.js');
  const { hash } = await import('../pipeline/state.js');
  const left = await eventInput(leftId); const right = await eventInput(rightId);
  if (!left || !right) throw new Error('Missing deferred pair fixture');
  const key = `consolidation_deferred:${randomUUID()}`;
  await store.saveState(key, { leftId, rightId, leftFingerprint: left.fingerprint, rightFingerprint: right.fingerprint,
    inputHash: hash([left,right]), intake: [], status: 'unresolved', originBatchId: null, originStageId: 'fixture', attempts: 1 });
  return key;
}
const drain = async () => (await import('./digest.js')).publishDigest(settings);
const maintain = async () => (await import('./digest.js')).resumePublications(settings);

describe.skipIf(!url)('durable per-story publication readiness', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:synthetic');
    database = await import('../db.js'); await database.migrate();
    ready = await import('./ready.js'); store = await import('./store.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); serial = 0;
    await database.db.query('TRUNCATE processing_batches,sources,stories,publications,request_attempts CASCADE');
    await database.db.query("DELETE FROM operational_state WHERE key LIKE 'run_now_%' OR key LIKE 'pipeline_failed_story:%' OR key LIKE 'consolidation_deferred:%'");
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true, minimumPublicationScore: 1 });
    await store.saveState('telegram_destination', { channelId: '-100123' });
    await store.saveState('bot_verified', { verified: true, destinationId: '-100123', botId: 123 });
    vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.spyOn(BotApi.prototype, 'send').mockImplementation(async () => String(++serial));
    vi.spyOn(BotApi.prototype, 'edit').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks(); if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('selects a ready event on a digest without waiting for every story in the batch', async () => {
    const batchId = await batch(); const first = await story(batchId); const second = await story(batchId);
    await database.db.query("UPDATE stories SET status='processing' WHERE id=$1", [second]);
    await database.db.query("INSERT INTO stage_state(batch_id,story_id,stage,status) VALUES($1,$2,'research','running')", [batchId, second]);
    await (await import('../pipeline/lease.js')).withLease('news-bot-pipeline', async () => {
      await enqueue(first, batchId); await drain();
      expect(BotApi.prototype.send).toHaveBeenCalledOnce();
      expect((await database.db.query('SELECT status FROM processing_batches WHERE id=$1', [batchId])).rows[0]?.status).toBe('processing');
    });
    expect((await database.db.query('SELECT story_id FROM publications')).rows).toEqual([{ story_id: first }]);
    await enqueue(first, batchId); await drain(); expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it('registers a first accepted batchless refresh completion and waits for digest selection', async () => {
    const batchId = await batch(); const id = await story(batchId);
    expect((await database.db.query('SELECT story_id FROM story_publication_ready WHERE story_id=$1', [id])).rows).toHaveLength(0);
    await enqueue(id, null);
    expect((await database.db.query('SELECT status FROM story_publication_ready WHERE story_id=$1', [id])).rows[0]?.status).toBe('pending');
    await maintain();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    await drain(); await maintain();
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it('recovers a committed ready event and an interrupted acknowledgment without creating a second publication', async () => {
    const batchId = await batch(); const id = await story(batchId); await enqueue(id, batchId);
    await database.db.query(`CREATE FUNCTION break_ready_ack() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='prepared' THEN RAISE EXCEPTION 'fixture interruption'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER break_ready_ack BEFORE UPDATE ON story_publication_ready FOR EACH ROW EXECUTE FUNCTION break_ready_ack()`);
    await expect(drain()).rejects.toThrow();
    expect((await database.db.query('SELECT status FROM publications')).rows).toEqual([{ status: 'prepared' }]);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    await database.db.query('DROP TRIGGER break_ready_ack ON story_publication_ready');
    await drain(); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(1);
  });
  it('maintenance leaves fresh events pending while delivering previously authorized work', async () => {
    const batchId = await batch(); const first = await story(batchId); await enqueue(first, batchId);
    await ready.prepareReadyStories(settings, '-100123');
    const second = await story(batchId); await enqueue(second, batchId);
    await maintain();
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT story_id FROM publications')).rows).toEqual([{ story_id: first }]);
    expect((await database.db.query('SELECT status FROM story_publication_ready WHERE story_id=$1', [second])).rows[0]?.status).toBe('pending');
    await maintain(); expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    await drain(); expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
  });
  it('selects more than twenty ready events in one digest', async () => {
    const batchId = await batch();
    for (let index = 0; index < 25; index++) await enqueue(await story(batchId), batchId);
    await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(25);
    expect((await database.db.query("SELECT story_id FROM story_publication_ready WHERE status='pending'")).rows).toHaveLength(0);
  }, 60_000);
  it('keeps ready work pending while publishing is paused, and leaves the earlier post immutable on a later ready event', async () => {
    const batchId = await batch(); const id = await story(batchId); await enqueue(id, batchId);
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: false });
    await drain(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status FROM story_publication_ready')).rows[0]?.status).toBe('pending');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    await drain();
    await sourceCorrection(id);
    await acceptFixtureStories(settings); await enqueue(id, batchId); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledOnce(); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
  });
  it('sends each ready event once despite unresolved consolidation and does not resend after resolution', async () => {
    const batchId = await batch(); const left = await story(batchId); const right = await story(batchId);
    const key = await deferPair(left, right);
    await enqueue(left, batchId); await enqueue(right, batchId);
    await drain(); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    expect((await database.db.query('SELECT status,reason FROM story_publication_ready')).rows)
      .toEqual([{ status: 'prepared', reason: null }, { status: 'prepared', reason: null }]);
    expect((await store.state(key))).toMatchObject({ status: 'unresolved' });
    await store.saveState(key, { status: 'resolved' });
    await maintain(); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(2);
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(2);
  });
  it('does not acknowledge a newer token arriving during ready-event preparation', async () => {
    const batchId = await batch(); const id = await story(batchId);
    await enqueue(id, batchId);
    await database.db.query(`CREATE FUNCTION new_ready_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN UPDATE story_publication_ready SET token=gen_random_uuid(),status='pending',reason=NULL
        WHERE story_id=NEW.story_id; RETURN NEW; END $$;
      CREATE TRIGGER new_ready_event AFTER INSERT ON publications FOR EACH ROW EXECUTE FUNCTION new_ready_event()`);
    try {
      await drain();
      expect((await database.db.query('SELECT status FROM story_publication_ready WHERE story_id=$1', [id])).rows[0]?.status).toBe('pending');
    } finally { await database.db.query('DROP TRIGGER new_ready_event ON publications'); }
    await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT status FROM story_publication_ready WHERE story_id=$1', [id])).rows[0]?.status).toBe('prepared');
  });
  it.each(['expired', 'manual'] as const)('retains %s guards despite unresolved consolidation', async guard => {
    const batchId = await batch(); const id = await story(batchId); const other = await story(batchId);
    await deferPair(id, other); await enqueue(id, batchId);
    if (guard === 'expired') await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE story_id=$1 AND stage='generation_research'", [id]);
    else await database.db.query('UPDATE story_publication_ready SET manual_operation_id=$2 WHERE story_id=$1', [id, randomUUID()]);
    await drain();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status,reason FROM story_publication_ready WHERE story_id=$1', [id])).rows[0])
      .toEqual({ status: 'withheld', reason: guard === 'expired' ? 'generation_not_current' : 'manual_scope' });
  });
  it('rechecks a below-threshold ready event on the next digest after the threshold is lowered', async () => {
    const batchId = await batch(); const id = await story(batchId); await enqueue(id, batchId);
    settings = await (await import('../settings.js')).saveSettings({ minimumPublicationScore: 9 });
    await drain(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    settings = await (await import('../settings.js')).saveSettings({ minimumPublicationScore: 8 });
    await maintain(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    await drain(); expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it.each(['failed', 'stale', 'legacy'] as const)('withholds %s input without any regeneration or send', async condition => {
    const batchId = await batch(); const id = await story(batchId); await enqueue(id, batchId);
    if (condition === 'failed') await database.db.query("UPDATE stories SET status='failed' WHERE id=$1", [id]);
    if (condition === 'stale') await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE story_id=$1 AND stage='eligibility'", [id]);
    if (condition === 'legacy') await database.db.query("DELETE FROM judgments WHERE story_id=$1 AND stage='generation_research'", [id]);
    await drain(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status FROM story_publication_ready WHERE story_id=$1', [id])).rows[0]?.status).toBe('withheld');
  });
  it('ignores a legacy release deferral without regenerating the current story', async () => {
    const batchId = await batch(); const id = await story(batchId); await enqueue(id, batchId);
    const receipts = (await database.db.query('SELECT id FROM judgments WHERE story_id=$1 ORDER BY id', [id])).rows;
    await store.saveState(`release_story_deferral:${id}`, {});
    await drain(); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT status FROM story_publication_ready WHERE story_id=$1', [id])).rows)
      .toEqual([{ status: 'prepared' }]);
    expect((await database.db.query('SELECT id FROM judgments WHERE story_id=$1 ORDER BY id', [id])).rows).toEqual(receipts);
  });
  it('serializes publishers and never sweeps completed history that has no ready event', async () => {
    const batchId = await batch(); const first = await story(batchId); await story(batchId); await enqueue(first, batchId);
    await store.locked('news-bot-digest', async () => { await maintain(); expect(BotApi.prototype.send).not.toHaveBeenCalled(); });
    await Promise.all([drain(), drain()]);
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect((await database.db.query('SELECT story_id FROM publications')).rows).toEqual([{ story_id: first }]);
  });
  it('protects unchanged intake from a retained pre-journal manual scope during automatic replay', async () => {
    const runId = randomUUID(); const oldBatch = await batch(runId); const id = await story(oldBatch);
    await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1", [oldBatch]);
    const normal = await batch();
    const revision = (await database.db.query<{ revision_id: string }>('SELECT revision_id FROM story_mentions WHERE story_id=$1', [id])).rows[0];
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [normal, revision?.revision_id]);
    await enqueue(id, normal); await drain();
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT status,manual_operation_id FROM story_publication_ready WHERE story_id=$1', [id])).rows[0])
      .toEqual({ status: 'manual', manual_operation_id: runId });
  });
  it('resumes a paused manual ready scope promptly without collecting or regenerating again', async () => {
    const runId = randomUUID(); const batchId = await batch(runId); const id = await story(batchId);
    await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1", [batchId]);
    await store.saveState(`run_now_batch:${batchId}`, { runId, storyLimit: 1, storyIds: [id] });
    await database.transaction(client => ready.ownManualStories(client, [id], runId, settings));
    const { runNowProgressSchema } = await import('../pipeline/run-now-contract.js');
    const job = { id: runId, createdAt: new Date().toISOString(), batchId,
      runNow: runNowProgressSchema.parse({ stage: 'publishing', options: { mode: 'collected', publicationLimit: 1, storyLimit: 1 } }) };
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: false });
    const { runNow } = await import('../pipeline/run-now.js');
    const paused = await runNow(job, async () => {}, new AbortController().signal);
    expect(paused.status).toBe('waiting'); expect(paused.message).toContain('paused');
    expect(Date.parse(paused.nextRetryAt ?? '') - Date.now()).toBeLessThanOrEqual(5000);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    expect((await runNow(job, async () => {}, new AbortController().signal)).status).toBe('succeeded');
    expect(BotApi.prototype.send).toHaveBeenCalledOnce(); expect(job.runNow.published).toBe(1);
  });
  it('publishes manual stories incrementally within the saved five-post cap with no automatic side channel', async () => {
    const runId = randomUUID(); const batchId = await batch(runId); const ids: string[] = [];
    for (let index = 0; index < 7; index++) ids.push(await story(batchId));
    await database.transaction(client => ready.ownManualStories(client, ids, runId, settings));
    const manual = await import('./run-now.js'); const createdAt = new Date().toISOString();
    for (const id of ids) {
      await enqueue(id, batchId);
      await store.locked('news-bot-digest', () => manual.publishRunNow(settings, runId, [id], 5, createdAt));
      await drain();
    }
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(5);
    const final = await store.locked('news-bot-digest', () => manual.publishRunNow(settings, runId, ids, 10, createdAt));
    expect(final.published).toBe(5); expect(final.reasons.publication_selection_limit).toBe(2);
    for (const id of ids) await enqueue(id, null); // General refresh does not authorize new manual-origin posts.
    await drain(); expect(BotApi.prototype.send).toHaveBeenCalledTimes(5);
    expect((await database.db.query('SELECT count(*)::int AS count FROM story_publication_ready WHERE manual_operation_id=$1', [runId])).rows[0]?.count).toBe(7);
    await database.db.query('DELETE FROM processing_batches WHERE id=$1', [batchId]);
    const normal = await batch();
    const unchanged = (await database.db.query<{ revision_id: string }>('SELECT revision_id FROM story_mentions WHERE story_id=$1', [ids[6]])).rows[0];
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [normal, unchanged?.revision_id]);
    await enqueue(ids[6] ?? '', normal); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(5); // Archived manual batches cannot erase the input boundary.
    await sourceCorrection(ids[0] ?? '');
    await acceptFixtureStories(settings); await enqueue(ids[0] ?? '', null); await drain();
    expect(BotApi.prototype.send).toHaveBeenCalledTimes(5); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
  }, 60_000);
});
