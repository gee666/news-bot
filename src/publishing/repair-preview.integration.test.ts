import { randomUUID } from 'node:crypto';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import type { PublicationSnapshot } from '../types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `repairpreview_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let repair: typeof import('./repair.js');
let preview: typeof import('./preview.js');
let settings: import('../settings.js').AppSettings;
const oldContent: PublicationSnapshot = { headline: 'Old title',details: 'Old details',score: 3,detailsKind: 'summary',sources: [] };
const testContent: PublicationSnapshot = { headline: 'Тест бота',details: 'Проверка публикации и редактирования.',score: 1,detailsKind: 'excerpt',sources: [] };
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function story(index = 0): Promise<string> {
  return one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,'Current generated details',8,true,false,$2,$3) RETURNING id`,
  [`Event ${index}`,settings.profileVersion,settings.modelVersion]);
}
async function publication(storyId: string | null, messageId: string, content = oldContent, botId = '123'): Promise<string> {
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(content)]);
  return one(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,status,bot_id)
    VALUES($1,$2,'-100123',$3,'published',$4) RETURNING id`,[storyId,snapshot,messageId,botId]);
}
async function registeredTest(botId = '123'): Promise<string> {
  const id = await publication(null,'3',testContent,botId);
  await store.saveState('bot_verification_test',{ publicationId: id,destinationId: '-100123',botId: 123 });
  return id;
}
async function provenance(storyId: string, number = 0, linkCount = 1, sourceOnly = false): Promise<void> {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram',$1,'Fixture','public') RETURNING id`,[`-100${number + 77}`]);
  const item = await one('INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,$2,$3) RETURNING id',
    [source,String(number + 1),sourceOnly ? null : `https://t.me/fixture/${number + 1}`]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,'fixture','News facts','News facts') RETURNING id`,[item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,item]);
  const mention = sourceOnly ? null : await one("INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,'News facts',0) RETURNING id",[storyId,revision]);
  for (let index = 0; index < linkCount; index++) {
    const link = await one("INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,'Supporting link') RETURNING id",
      [revision,`https://publisher.example.com/${index}`]);
    if (sourceOnly) await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','fixture',$3,'fixture','fixture')`,[link,storyId,settings.modelVersion]);
    else await database.db.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')",[mention,link]);
    const doc = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES($1,'Read supporting document','Actual source text about the event','public',now()+interval '1 day') RETURNING id`,
    [`https://publisher.example.com/${index}`]);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[storyId,doc]);
  }
}
async function pointers(): Promise<unknown> {
  return (await database.db.query(`SELECT (SELECT count(*) FROM publication_snapshots) AS snapshots,
    (SELECT count(*) FROM request_attempts) AS attempts,(SELECT count(*) FROM publication_replacements) AS replacements,
    (SELECT jsonb_agg(jsonb_build_array(id,snapshot_id,pending_snapshot_id,format_version) ORDER BY id) FROM publications) AS publications`)).rows[0];
}

describe.skipIf(!url)('reviewed repair preview and registered verification test', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
    store = await import('./store.js'); repair = await import('./repair.js'); preview = await import('./preview.js');
    await store.saveState('telegram_destination',{ channelId: '-100123' });
    await store.saveState('bot_verified',{ verified: true,destinationId: '-100123',botId: 123 });
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(BotApi.prototype,'identity').mockRejectedValue(new Error('Live identity calls forbidden'));
    vi.spyOn(BotApi.prototype,'send').mockRejectedValue(new Error('Live sends forbidden'));
    vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new Error('Live edits forbidden'));
    vi.spyOn(BotApi.prototype,'delete').mockRejectedValue(new Error('Live deletes forbidden'));
    await database.db.query('TRUNCATE stories,sources,publications,publication_snapshots,request_attempts,publication_replacements CASCADE');
    await database.db.query("DELETE FROM operational_state WHERE key='bot_verification_test'");
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('previews 21 fresh canonical posts, all 17 URLs and both origins, three duplicates and only the registered test without writes or HTTP', async () => {
    const testId = await registeredTest();
    for (let index = 0; index < 21; index++) {
      const id = await story(index); await publication(id,String(100 + index)); await provenance(id,index,index ? 1 : 17);
      if (!index) {
        await provenance(id,40,1,true);
        for (let sibling = 0; sibling < 3; sibling++) {
          const loser = await story(40 + sibling); await publication(loser,String(200 + sibling));
          await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[loser,id]);
        }
      }
    }
    const before = await pointers();
    await acceptFixtureStories(settings);
    const plan = await preview.previewPublicationRepair({ includeVerificationTest: true });
    expect(plan).toMatchObject({ eligiblePosts: 21,readyPosts: 21,allReady: true,identityCheck: 'persisted_only' });
    expect(plan.proposedDuplicateDeletions.map(item => item.messageId).sort()).toEqual(['200','201','202']);
    expect(plan.verificationTest).toMatchObject({ publicationId: testId,messageId: '3',ready: true,metrics: { sourceUrls: 0 } });
    expect(plan.posts.find(post => post.messageId === '100')).toMatchObject({ expectedSourceUrls: 19,missingSourceUrls: 0,
      publishedSnapshotMatchesDesired: false,metrics: { sourceUrls: 19,entities: 21,allSnapshotLinksRendered: true } });
    expect(plan.posts.every(post => post.metrics && post.metrics.characters <= 4096 && post.metrics.entities <= 100)).toBe(true);
    expect(JSON.stringify(plan)).not.toContain('Current generated details'); expect(JSON.stringify(plan)).not.toContain(testContent.details);
    expect(await pointers()).toEqual(before);
    for (const method of ['identity','send','edit','delete'] as const) expect(BotApi.prototype[method]).not.toHaveBeenCalled();
  });
  it('enforces read-only SQL even if a snapshot reader accidentally attempts a write', async () => {
    const id = await story(); await publication(id,'5'); await provenance(id);
    vi.spyOn(store,'snapshotFor').mockImplementation(async client => {
      await client.query("UPDATE stories SET headline='Unwanted mutation' WHERE id=$1",[id]); return oldContent;
    });
    await expect(preview.previewPublicationRepair()).rejects.toMatchObject({ code: '25006' });
    expect((await database.db.query<{ headline: string }>('SELECT headline FROM stories WHERE id=$1',[id])).rows[0]?.headline).toBe('Event 0');
  });
  it('fails the independent inventory check if rendering would omit a current supporting URL', async () => {
    const id = await story(); await publication(id,'5'); await provenance(id);
    await acceptFixtureStories(settings);
    vi.spyOn(store,'snapshotFor').mockResolvedValue({ ...oldContent,sources: [] });
    const plan = await preview.previewPublicationRepair();
    expect(plan.allReady).toBe(false); expect(plan.posts[0]).toMatchObject({ expectedSourceUrls: 2,missingSourceUrls: 2,ready: false });
  });
  it('also checks independently verified supporting evidence even without a raw mention link', async () => {
    const id = await story(); await publication(id,'5'); await provenance(id);
    const evidence = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES('https://assessed.example.com/release','Assessed source','Actual read announcement','public',now()+interval '1 day') RETURNING id`);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[id,evidence]);
    await acceptFixtureStories(settings);
    const original = store.snapshotFor;
    vi.spyOn(store,'snapshotFor').mockImplementation(async (client,content) => {
      const snapshot = await original(client,content);
      return { ...snapshot,sources: snapshot.sources.filter(source => source.url !== 'https://assessed.example.com/release') };
    });
    const plan = await preview.previewPublicationRepair();
    expect(plan.posts[0]).toMatchObject({ expectedSourceUrls: 3,missingSourceUrls: 1,ready: false });
  });
  it('does not bypass a durable 429 cooldown when explicitly converting the registered test', async () => {
    const id = await registeredTest();
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code,next_retry_at,response_metadata)
      SELECT id,'telegram-bot','edit',1,'retryable','telegram_rate_limit',now()+interval '1 hour',jsonb_build_object('snapshotId',snapshot_id) FROM publications WHERE id=$1`,[id]);
    const plan = await preview.previewPublicationRepair({ includeVerificationTest: true });
    expect(plan.allReady).toBe(false); expect(plan.verificationTest?.issues).toContain('telegram_cooldown');
    vi.mocked(BotApi.prototype.identity).mockResolvedValue({ id: 123,is_bot: true });
    expect(await repair.repairExistingPublications(settings,{ includeVerificationTest: true })).toEqual({ edited: 0,deleted: 0 });
    expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect(await store.rateLimited()).toBe(true);
  });
  it('previews oversized generated details as a trimmed edit without writes or HTTP', async () => {
    const id = await story(); await publication(id,'5'); await provenance(id);
    await database.db.query('UPDATE stories SET summary=$1 WHERE id=$2',['x'.repeat(5000),id]);
    await acceptFixtureStories(settings);
    const before = await pointers();
    const plan = await preview.previewPublicationRepair();
    expect(plan.allReady).toBe(true);
    expect(plan.posts[0]).toMatchObject({ ready: true, issues: [], wouldStageSnapshot: true,
      metrics: { sourceUrls: 2, allSnapshotLinksRendered: true } });
    expect(plan.posts[0]?.metrics?.characters).toBeLessThanOrEqual(4096);
    expect(await pointers()).toEqual(before);
    for (const method of ['identity','send','edit','delete'] as const) expect(BotApi.prototype[method]).not.toHaveBeenCalled();
  });
  it('edits the existing registered test from its full saved content and never touches other null-story messages or sends/deletes anything', async () => {
    const testId = await registeredTest(); const other = await publication(null,'4',oldContent);
    vi.mocked(BotApi.prototype.identity).mockResolvedValue({ id: 123,is_bot: true }); vi.mocked(BotApi.prototype.edit).mockResolvedValue(undefined);
    const before = await pointers();
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 0,deleted: 0 });
    expect(await repair.repairExistingPublications(settings,{ includeVerificationTest: true })).toEqual({ edited: 1,deleted: 0 });
    expect(BotApi.prototype.edit).toHaveBeenCalledExactlyOnceWith('-100123','3',expect.objectContaining({ reply_markup: { inline_keyboard: [] } }));
    const rows = (await database.db.query<{ id: string; format_version: number; content: unknown }>(`${store.publicationSelect} WHERE p.id=ANY($1::uuid[])`,[[testId,other]])).rows;
    expect(rows.find(row => row.id === testId)).toMatchObject({ content: testContent,format_version: 1 });
    expect(rows.find(row => row.id === other)).toMatchObject({ content: oldContent,format_version: 0 });
    expect((await pointers())).not.toEqual(before);
    expect(BotApi.prototype.send).not.toHaveBeenCalled(); expect(BotApi.prototype.delete).not.toHaveBeenCalled();
  });
  it('fails closed before any correction if the registered test is not owned by the verified bot', async () => {
    await registeredTest('999'); const id = await story(); await publication(id,'5'); await provenance(id);
    const before = await pointers(); const plan = await preview.previewPublicationRepair({ includeVerificationTest: true });
    expect(plan.allReady).toBe(false); expect(plan.verificationTest?.ready).toBe(false);
    vi.mocked(BotApi.prototype.identity).mockResolvedValue({ id: 123,is_bot: true });
    await expect(repair.repairExistingPublications(settings,{ includeVerificationTest: true })).rejects.toThrow('verification_test_not_owned');
    expect(await pointers()).toEqual(before); expect(BotApi.prototype.edit).not.toHaveBeenCalled(); expect(BotApi.prototype.delete).not.toHaveBeenCalled();
  });
  it('edits a fresh canonical full post before deleting its duplicates and confirms the published desired hash afterwards', async () => {
    const id = await story(); const canonical = await publication(id,'5'); await provenance(id); await registeredTest();
    const loser = await story(1); await publication(loser,'6');
    await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[loser,id]);
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled:true });
    await acceptFixtureStories(settings);
    const plan = await preview.previewPublicationRepair({ includeVerificationTest: true });
    const calls: string[] = []; vi.mocked(BotApi.prototype.identity).mockResolvedValue({ id: 123,is_bot: true });
    vi.mocked(BotApi.prototype.edit).mockImplementation(async (_destination,messageId,message) => {
      calls.push(`edit:${messageId}`); expect(message.reply_markup.inline_keyboard).toEqual([]);
      if (messageId === '5') expect(message.text).toContain('Current generated details');
    });
    vi.mocked(BotApi.prototype.delete).mockImplementation(async (_destination,messageId) => { calls.push(`delete:${messageId}`); });
    expect(await repair.repairExistingPublications(settings,{ includeVerificationTest: true })).toEqual({ edited: 2,deleted: 1 });
    expect(calls).toEqual(['edit:5','edit:3','delete:6']);
    const after = await preview.previewPublicationRepair({ includeVerificationTest: true });
    expect(after.proposedDuplicateDeletions).toEqual([]); expect(after.allReady).toBe(true);
    expect(after.posts.find(post => post.publicationId === canonical)).toMatchObject({ publishedSnapshotMatchesDesired: true,
      metrics: { snapshotSha256: plan.posts[0]?.metrics?.snapshotSha256 },missingSourceUrls: 0 });
    expect(after.verificationTest?.storedFormatVersion).toBe(1);
  });
});
