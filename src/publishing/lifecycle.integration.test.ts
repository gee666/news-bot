import { randomUUID } from 'node:crypto';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import { render } from './render.js';
import type { PublicationSnapshot } from '../types.js';
import type { Publication } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `publifecycle_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let reconciliation: typeof import('./reconciliation.js');
let store: typeof import('./store.js');
let updates: typeof import('./updates.js');
let delivery: typeof import('./delivery.js');
let digest: typeof import('./digest.js');
let settings: import('../settings.js').AppSettings;
const original: PublicationSnapshot = { headline: 'Раньше',details: 'Старые детали',score: 3,detailsKind: 'summary',sources: [] };
const current: PublicationSnapshot = { headline: 'Событие целиком',details: 'Все новые подробности',score: 8,detailsKind: 'summary',sources: [],
  review: { supported: true, reason: 'Существенных ошибок не найдено' } };
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Fixture missing'); return row.id;
}
async function story(): Promise<string> {
  const id = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,$2,8,true,false,$3,$4) RETURNING id`,[current.headline,current.details,settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings);
  return id;
}
async function publication(storyId: string, status: Publication['status'] = 'prepared'): Promise<string> {
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(original)]);
  return one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status,message_id,bot_id)
    VALUES($1,$2,'-100123',$3,$4,'123') RETURNING id`,[storyId,snapshot,status,status === 'published' ? '5' : null]);
}
async function row(id: string): Promise<Publication> {
  const publication = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!publication) throw new Error('Publication missing'); return publication;
}
async function alias(canonical: string, loser: string, publicationId: string): Promise<void> {
  await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[loser,canonical]);
  await database.db.query(`INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id)
    VALUES($1,$2,$3)`,[publicationId,loser,canonical]);
  await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[loser]);
}
async function pendingEdit(outcome: 'unknown' | 'retryable' = 'unknown') {
  const storyId = await story(); const id = await publication(storyId,'published');
  await updates.prepareUpdates(settings,'-100123');
  const desiredId = (await row(id)).pending_snapshot_id;
  if (!desiredId) throw new Error('Desired snapshot missing');
  const edit = vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new BotError(
    outcome === 'unknown' ? 'telegram_transport_unknown' : 'telegram_rate_limit',outcome,120_000));
  expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
  await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
  return { id,storyId,desiredId,edit };
}

describe.skipIf(!url)('publication lifecycle blockers in PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    // Reconciliation imports db. Load it only after the disposable schema URL is installed.
    database = await import('../db.js');
    const current = await database.db.query<{ schema: string }>('SELECT current_schema() AS schema');
    if (current.rows[0]?.schema !== schema) throw new Error('Lifecycle tests require their disposable schema');
    await database.migrate();
    reconciliation = await import('./reconciliation.js');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    store = await import('./store.js'); updates = await import('./updates.js'); delivery = await import('./delivery.js'); digest = await import('./digest.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id: 123,is_bot: true });
    vi.spyOn(BotApi.prototype,'send').mockRejectedValue(new Error('Live sends forbidden'));
    await database.db.query('TRUNCATE stories,publications,publication_snapshots,story_merges,request_attempts,evidence_documents CASCADE');
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it.each([false,true])('adopts the only unsent loser atomically and sends canonical content once, with raw loser removed=%s', async removed => {
    const canonical = await story(); const loser = await story(); const id = await publication(loser);
    const previous = await row(id); await alias(canonical,loser,id);
    if (removed) await database.db.query('DELETE FROM stories WHERE id=$1',[loser]);
    await store.prepareDigest(settings,'-100123');
    const adopted = await row(id);
    expect(adopted.story_id).toBe(canonical); expect(adopted.status).toBe('prepared'); expect(adopted.content).toEqual(current);
    expect(adopted.snapshot_id).not.toBe(previous.snapshot_id);
    expect((await database.db.query('SELECT id FROM publications')).rows).toEqual([{ id }]);
    expect((await database.db.query('SELECT original_story_id FROM story_publication_aliases WHERE publication_id=$1',[id])).rows[0]?.original_story_id).toBe(loser);
    expect((await database.db.query('SELECT content FROM publication_snapshots WHERE id=$1',[previous.snapshot_id])).rows[0]?.content).toEqual(original);
    const send = vi.spyOn(BotApi.prototype,'send').mockImplementation(async (_destination,message) => {
      expect(message.text).toContain(current.details); expect(message.text).not.toContain(original.details); return '9';
    });
    expect(await delivery.sendPrepared(adopted,new BotApi(),settings)).toBe('9');
    await store.prepareDigest(settings,'-100123');
    expect(await delivery.sendPrepared(await row(id),new BotApi(),settings)).toBeNull(); expect(send).toHaveBeenCalledOnce();
  });
  it.each(['prepared','published'] as const)('retires an unsent sibling when the canonical publication is already %s', async status => {
    const canonical = await story(); const loser = await story(); const owner = await publication(canonical,status); const sibling = await publication(loser);
    await alias(canonical,loser,sibling); await store.prepareDigest(settings,'-100123');
    expect((await row(owner)).status).toBe(status); expect((await row(sibling)).status).toBe('failed');
    expect((await database.db.query('SELECT error_code FROM publications WHERE id=$1',[sibling])).rows[0]?.error_code).toBe('publication_superseded');
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(2);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('adopts one of multiple definitely unsent siblings and retires the rest without duplicate selection', async () => {
    const canonical = await story(); const firstLoser = await story(); const secondLoser = await story();
    const first = await publication(firstLoser); const second = await publication(secondLoser);
    await alias(canonical,firstLoser,first); await alias(canonical,secondLoser,second);
    await database.db.query("UPDATE publications SET created_at=now()-interval '1 day' WHERE id=$1",[first]);
    await store.prepareDigest(settings,'-100123');
    expect((await row(first)).story_id).toBe(canonical); expect((await row(first)).status).toBe('prepared'); expect((await row(second)).status).toBe('failed');
    expect((await database.db.query("SELECT id FROM publications WHERE status='prepared'")).rows).toEqual([{ id: first }]);
  });
  it.each(['running','unknown','retryable'] as const)('does not adopt a prepared row with an unsafe %s send; recovery reconciles it instead', async status => {
    const canonical = await story(); const loser = await story(); const id = await publication(loser); const previous = await row(id);
    await alias(canonical,loser,id);
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code,response_metadata)
      VALUES($1,'telegram-bot','send',1,$2,'telegram_transport_unknown',$3)`,[id,status,JSON.stringify(reconciliation.sendMetadata(render(original)))]);
    await store.prepareDigest(settings,'-100123'); expect((await row(id)).story_id).toBe(loser); expect((await row(id)).snapshot_id).toBe(previous.snapshot_id);
    await digest.recoverSends('-100123'); expect((await row(id)).status).toBe('uncertain');
    expect((await database.db.query('SELECT status FROM request_attempts WHERE publication_id=$1',[id])).rows[0]?.status).toBe('unknown');
    await store.prepareDigest(settings,'-100123'); expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(1);
    expect(await delivery.reconcile(await row(id),settings,async () => '9')).toBe(true);
    await updates.prepareUpdates(settings,'-100123');
    const edit = vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(1); expect(edit.mock.calls[0]?.[1]).toBe('9');
    expect((await row(id)).content).toEqual(current); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('adopts a known 429 rejection but preserves its durable retry deadline', async () => {
    const canonical = await story(); const loser = await story(); const id = await publication(loser); await alias(canonical,loser,id);
    const deadline = new Date(Date.now()+120_000);
    await database.db.query('UPDATE publications SET next_retry_at=$1 WHERE id=$2',[deadline,id]);
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code,next_retry_at)
      VALUES($1,'telegram-bot','send',1,'retryable','telegram_rate_limit',$2)`,[id,deadline]);
    await store.prepareDigest(settings,'-100123'); expect((await row(id)).story_id).toBe(canonical); expect((await row(id)).next_retry_at).toEqual(deadline);
    expect(await store.rateLimited()).toBe(true); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('retires a safe 429 sibling retry without erasing the bot cooldown', async () => {
    const canonical = await story(); const loser = await story(); await publication(canonical); const id = await publication(loser);
    await alias(canonical,loser,id); const deadline = new Date(Date.now()+120_000);
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code,next_retry_at)
      VALUES($1,'telegram-bot','send',1,'retryable','telegram_rate_limit',$2)`,[id,deadline]);
    await store.prepareDigest(settings,'-100123'); expect((await row(id)).status).toBe('failed');
    expect((await database.db.query('SELECT status,error_code,next_retry_at FROM request_attempts WHERE publication_id=$1',[id])).rows).toEqual([
      { status: 'failed',error_code: 'telegram_rate_limit',next_retry_at: deadline },
    ]);
    expect(await store.rateLimited()).toBe(true); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it.each(['unknown','retryable'] as const)('stages a trimmed summary replacement while preserving an older %s edit\'s delivery safety', async outcome => {
    const { id,storyId,desiredId,edit } = await pendingEdit(outcome); const publishedId = (await row(id)).snapshot_id;
    const summary = '😀'.repeat(3000);
    await database.db.query('UPDATE stories SET summary=$1 WHERE id=$2',[summary,storyId]);
    await acceptFixtureStories(settings);
    await updates.prepareUpdates(settings,'-100123');
    const next = (await row(id)).pending_snapshot_id;
    expect(next).not.toBeNull(); expect(next).not.toBe(desiredId);
    expect((await row(id)).snapshot_id).toBe(publishedId); expect((await row(id)).content).toEqual(original);
    expect((await database.db.query("SELECT status,error_code,next_retry_at FROM request_attempts WHERE operation='edit' AND publication_id=$1",[id])).rows).toEqual([
      outcome === 'unknown' ? { status:'unknown',error_code:'telegram_transport_unknown',next_retry_at:expect.any(Date) }
        : { status:'failed',error_code:'edit_superseded',next_retry_at:null },
    ]);
    expect((await database.db.query('SELECT content FROM publication_snapshots WHERE id=$1',[next])).rows[0]?.content)
      .toEqual({ ...current, details: summary });
    edit.mockResolvedValue(undefined);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(outcome === 'unknown' ? 0 : 1);
    if (outcome === 'unknown') {
      expect(edit).toHaveBeenCalledOnce();
      expect((await row(id)).pending_snapshot_id).toBe(next); expect((await row(id)).snapshot_id).toBe(publishedId);
      expect((await row(id)).content).toEqual(original);
      expect((await database.db.query("SELECT status FROM request_attempts WHERE publication_id=$1 AND operation='edit'",[id])).rows)
        .toEqual([{ status: 'unknown' }]);
    } else {
      expect(edit).toHaveBeenCalledTimes(2);
      expect(edit.mock.calls[1]?.[2].plainText.length).toBeLessThanOrEqual(4096);
      expect(edit.mock.calls[1]?.[2].plainText).toMatch(/…$/u);
      expect((await row(id)).content).toEqual({ ...current, details: summary });
      expect((await row(id)).pending_snapshot_id).toBeNull(); expect((await row(id)).snapshot_id).toBe(next);
    }
    expect((await database.db.query('SELECT content FROM publication_snapshots WHERE id=$1',[desiredId])).rows[0]?.content).toEqual(current);
    expect((await database.db.query("SELECT error_code FROM request_attempts WHERE operation='prepare_edit'")).rows).toEqual([]);
  });
  it('cancels a superseded summary before maintenance retry even without a new preparation tick', async () => {
    const { id,storyId,edit } = await pendingEdit();
    await database.db.query('UPDATE stories SET summary=$1 WHERE id=$2',['😀'.repeat(3000),storyId]);
    edit.mockResolvedValue(undefined); expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect((await row(id)).pending_snapshot_id).toBeNull(); expect(edit).toHaveBeenCalledOnce();
  });
  it('invalidates an edit on entity-limit preflight failure even with unchanged headline/details/score', async () => {
    const { id,storyId,edit } = await pendingEdit();
    await database.db.query(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      SELECT 'https://publisher.org/'||n,'Источник '||n,'Actual read relevant source text','public',now()+interval '1 day' FROM generate_series(1,99) n`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at)
      SELECT $1,id,'supporting','relevant',now() FROM evidence_documents WHERE url<>'https://fixture.example/announcement'`,[storyId]);
    await acceptFixtureStories(settings);
    await updates.prepareUpdates(settings,'-100123'); expect((await row(id)).pending_snapshot_id).toBeNull();
    edit.mockResolvedValue(undefined); expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0); expect(edit).toHaveBeenCalledOnce();
    expect((await database.db.query("SELECT error_code FROM request_attempts WHERE operation='prepare_edit'")).rows).toEqual([
      { error_code: 'publication_entity_limit' },
    ]);
  });
  it.each([true,false])('invalidates a pending edit on a rejected live story, with preparation=%s', async prepare => {
    const { id,storyId,edit } = await pendingEdit(); await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[storyId]);
    if (prepare) await updates.prepareUpdates(settings,'-100123');
    edit.mockResolvedValue(undefined); expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect((await row(id)).pending_snapshot_id).toBeNull(); expect((await row(id)).content).toEqual(original); expect(edit).toHaveBeenCalledOnce();
  });
  it('preserves Telegram global cooldown when a superseded edit is canceled', async () => {
    const { id,storyId } = await pendingEdit('retryable'); const deadline = new Date(Date.now()+120_000);
    await database.db.query('UPDATE request_attempts SET next_retry_at=$1 WHERE publication_id=$2',[deadline,id]);
    await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[storyId]);
    await updates.prepareUpdates(settings,'-100123'); expect((await row(id)).pending_snapshot_id).toBeNull();
    const attempt = (await database.db.query('SELECT status,error_code,next_retry_at,response_metadata FROM request_attempts WHERE publication_id=$1',[id])).rows[0];
    expect(attempt).toMatchObject({ status: 'failed',error_code: 'telegram_rate_limit',next_retry_at: deadline });
    expect(attempt?.response_metadata.superseded).toBe(true); expect(await store.rateLimited()).toBe(true);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
  });
  it('preserves a retained desired snapshot and unknown outcome for review without blind retry', async () => {
    const { id,storyId,desiredId,edit } = await pendingEdit(); await database.db.query('DELETE FROM stories WHERE id=$1',[storyId]);
    await updates.prepareUpdates(settings,'-100123'); expect((await row(id)).pending_snapshot_id).toBe(desiredId);
    edit.mockResolvedValue(undefined); expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect((await row(id)).pending_snapshot_id).toBe(desiredId); expect((await row(id)).content).toEqual(original); expect(edit).toHaveBeenCalledOnce();
    expect((await database.db.query("SELECT status FROM request_attempts WHERE operation='edit'")).rows).toEqual([{ status:'unknown' }]);
  });
});
