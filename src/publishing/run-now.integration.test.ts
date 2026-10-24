import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import { jevTemplates } from '../models/templates.js';
const url = process.env.TEST_DATABASE_URL;
const schema = `manual_publish_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let manual: typeof import('./run-now.js');
let settings: import('../settings.js').AppSettings;
const destination = '-100123';
let messageSequence = 100;
async function one(sql: string, args: unknown[] = []) {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Fixture missing'); return row.id;
}
async function story(label: string) {
  const id = await one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,'Full details','An event',8,true,false,$2,$3) RETURNING id`, [label, settings.profileVersion, settings.modelVersion]);
  await acceptFixtureStories(settings);
  await database.db.query(`INSERT INTO judgments(story_id,stage,input_hash,model_key,prompt_version,profile_version,model_version,result,expires_at)
    SELECT id,'eligibility','fixture','fixture',$2,$3,$4,jsonb_build_object('eligible',true,'contentVersion',content_version),now()+interval '7 days'
    FROM stories WHERE id=$1`, [id, jevTemplates.news_eligibility.version, settings.profileVersion, settings.modelVersion]);
  return id;
}
async function published(storyId: string) {
  const headline=(await database.db.query<{headline:string}>('SELECT headline FROM stories WHERE id=$1',[storyId])).rows[0]?.headline;
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
    [storyId, JSON.stringify({ headline, details: 'Full details', score: 8, detailsKind: 'summary', sources: [{label:'Old source',url:'https://old.example/report',primary:false,access:'public',classification:'relevant'}] })]);
  return one(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,status,bot_id)
    VALUES($1,$2,$3,$4,'published','123') RETURNING id`, [storyId, snapshot, destination, String(messageSequence++)]);
}
const invoke = (runId: string, ids: string[], limit = 1, createdAt = new Date().toISOString()) =>
  store.locked('news-bot-digest', () => manual.publishRunNow(settings, runId, ids, limit, createdAt));

describe.skipIf(!url)('scoped manual publication with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:synthetic');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    store = await import('./store.js'); manual = await import('./run-now.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); messageSequence = 100;
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query("DELETE FROM operational_state WHERE key LIKE 'run_now_%'");
    await store.saveState('telegram_destination', { channelId: destination });
    await store.saveState('bot_verified', { verified: true, destinationId: destination, botId: 123 });
    vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.spyOn(BotApi.prototype, 'send').mockResolvedValue('42');
    vi.spyOn(BotApi.prototype, 'edit').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks(); if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('prepares at most the limit only for this run and never drains old prepared or eligible backlog', async () => {
    const oldPrepared = await story('Old prepared');
    await store.prepareDigest(settings, destination); // Existing selection must not belong to the manual run.
    const eligibleBacklog = await story('Eligible backlog');
    const ids = [oldPrepared, await story('New one'), await story('New two')]; const runId = randomUUID();
    const first = await invoke(runId, ids);
    expect(first).toMatchObject({ published: 1, updated: 0, waiting: false, reasons: { publication_selection_limit: 1 } });
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    expect(first.reasons.existing_publication_prepared).toBe(1);
    expect((await database.db.query('SELECT status FROM publications WHERE story_id=$1', [oldPrepared])).rows[0]?.status).toBe('prepared');
    expect((await database.db.query('SELECT id FROM publications WHERE story_id=$1', [eligibleBacklog])).rows).toHaveLength(0);
    expect(await invoke(runId, ids)).toMatchObject({ published: 1, waiting: false });
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it('leaves existing posts unchanged instead of automatically staging source repairs', async () => {
    const unrelated = await story('Unrelated current'); const unrelatedPublication = await published(unrelated);
    const affected = await story('Affected current'); await published(affected);
    const next = await story('New story'); const createdAt = new Date(Date.now() - 1000).toISOString();
    const result = await invoke(randomUUID(), [affected, next], 1, createdAt);
    expect(result).toMatchObject({ published: 1, updated: 0, waiting: false });
    expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT pending_snapshot_id FROM publications WHERE id=$1', [unrelatedPublication])).rows[0]?.pending_snapshot_id).toBeNull();
  });
  it('retains cumulative counts when publishing pauses and attributes only pinned edit snapshots', async () => {
    const affected = await story('Existing affected'); await published(affected);
    const next = await story('New story'); const runId = randomUUID(); const createdAt = new Date(Date.now() - 1000).toISOString();
    expect(await invoke(runId, [affected, next], 1, createdAt)).toMatchObject({ published: 1, updated: 0 });
    const selection = (await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`run_now_publications:${runId}`])).rows[0]?.value;
    expect(selection.editTargets ?? []).toHaveLength(0);
    // A later explicit repair must not count as an update selected by this run.
    const evidence=await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES('https://new.example/report','New source','New report details','public',now()+interval '1 day') RETURNING id`);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[next,evidence]);
    await acceptFixtureStories(settings);
    const updates = await import('./updates.js'); await updates.prepareUpdates(settings, destination, [affected], { sourceRepair: true });
    await updates.retryEdits(new BotApi(), settings, destination, [affected]);
    await (await import('../settings.js')).saveSettings({ publishingEnabled: false });
    expect(await invoke(runId, [affected, next], 1, createdAt))
      .toMatchObject({ published: 1, updated: 0, waiting: false, reasons: { publishing_disabled: 1 } });
    expect(BotApi.prototype.send).toHaveBeenCalledOnce(); expect(BotApi.prototype.edit).toHaveBeenCalledOnce();
  });
  it('counts a manual publication only after its continuation text is completely delivered', async () => {
    const id = await story('Long cumulative edition');
    await database.db.query('UPDATE stories SET summary=$2 WHERE id=$1',[id,'Полные факты 😀 '.repeat(1000)]);
    await acceptFixtureStories(settings,[id]);
    const runId = randomUUID();
    const send = vi.mocked(BotApi.prototype.send).mockResolvedValueOnce('42')
      .mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000));
    expect(await invoke(runId,[id])).toMatchObject({ published: 0, waiting: true });
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await database.db.query("UPDATE publication_text_parts SET next_retry_at=now()-interval '1 second'");
    send.mockImplementation(async () => String(100+send.mock.calls.length));
    expect(await invoke(runId,[id])).toMatchObject({ published: 1, waiting: false });
    expect(send.mock.calls.filter(call => call[2] === undefined)).toHaveLength(1);
  });
  it('does not resend an unknown send after restart and respects its durable cooldown', async () => {
    const id = await story('Uncertain event'); const runId = randomUUID();
    vi.mocked(BotApi.prototype.send).mockRejectedValue(new BotError('telegram_transport_unknown', 'unknown'));
    const first = await invoke(runId, [id]); expect(first.waiting).toBe(true);
    const delivery = await import('./delivery.js'); const reconcile = vi.spyOn(delivery, 'reconcile').mockResolvedValue(false);
    expect((await invoke(runId, [id])).waiting).toBe(true);
    expect(BotApi.prototype.send).toHaveBeenCalledOnce(); expect(reconcile).not.toHaveBeenCalled();
    await database.db.query("UPDATE publications SET status='sending',next_retry_at=NULL WHERE story_id=$1", [id]);
    await invoke(runId, [id]);
    expect((await database.db.query('SELECT status,next_retry_at FROM publications WHERE story_id=$1', [id])).rows[0])
      .toMatchObject({ status: 'uncertain', next_retry_at: expect.any(Date) });
    expect(reconcile).not.toHaveBeenCalled(); expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
  it('withholds a completed story when its eligibility receipt expired before publication', async () => {
    const id = await story('Expired decision');
    await database.db.query("UPDATE judgments SET expires_at=now()-interval '1 second' WHERE story_id=$1 AND stage='eligibility'", [id]);
    const result = await invoke(randomUUID(), [id]);
    expect(result).toMatchObject({ published: 0, waiting: false, reasons: { eligibility_or_ranking_stale: 1 } });
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT id FROM publications WHERE story_id=$1', [id])).rows).toHaveLength(0);
  });
  it('reports failed edits rather than successful completion', async () => {
    const id = await story('Corrected story'); await published(id);
    await (await import('./updates.js')).prepareUpdates(settings,destination,[id],{ sourceRepair: true });
    vi.mocked(BotApi.prototype.edit).mockRejectedValue(new BotError('telegram_edit_rejected', 'failed'));
    const result = await invoke(randomUUID(), [id]);
    expect(result).toMatchObject({ published: 0, updated: 0, waiting: false, reasons: { edit_telegram_edit_rejected: 1 } });
  });
  it('recovers interrupted scoped edits as unknown without blindly resubmitting them', async () => {
    const id = await story('Corrected story'); const publication = await published(id);
    const updates = await import('./updates.js'); await updates.prepareUpdates(settings, destination, [id], { sourceRepair: true });
    const pending = (await database.db.query<{ pending_snapshot_id: string }>('SELECT pending_snapshot_id FROM publications WHERE id=$1', [publication])).rows[0];
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      VALUES($1,'telegram-bot','edit',1,'running',$2)`, [publication, JSON.stringify({ snapshotId: pending?.pending_snapshot_id, fingerprint: 'a'.repeat(64) })]);
    const result = await invoke(randomUUID(), [id]);
    expect(result.waiting).toBe(true); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect(result.reasons.edit_restart_edit_unknown).toBe(1);
    expect((await database.db.query("SELECT status,next_retry_at FROM request_attempts WHERE operation='edit'")).rows[0])
      .toMatchObject({ status: 'unknown', next_retry_at: expect.any(Date) });
  });
  it('binds retry selection to the original destination and never sends on the replacement destination', async () => {
    const id = await story('New story'); const runId = randomUUID();
    vi.mocked(BotApi.prototype.send).mockRejectedValue(new BotError('telegram_rate_limit', 'retryable', 1));
    await invoke(runId, [id]);
    await store.saveState('telegram_destination', { channelId: '-100456' });
    await store.saveState('bot_verified', { verified: true, destinationId: '-100456', botId: 123 });
    const second = await invoke(runId, [id]);
    expect(second).toMatchObject({ waiting: false, reasons: { destination_changed: 1 } });
    expect(BotApi.prototype.send).toHaveBeenCalledOnce();
  });
});
