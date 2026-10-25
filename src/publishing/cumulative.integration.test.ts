import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError, type PublicationMedia } from './bot-api.js';
import { renderFullText } from './full-text.js';
import { renderCaption } from './caption.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { PublicationSnapshot } from '../types.js';
import type { Publication } from './store.js';

const media = vi.hoisted(() => ({ publicationMedia: vi.fn(), releaseStoryMedia: vi.fn() }));
vi.mock('../media/story-media.js', () => media);
const url = process.env.TEST_DATABASE_URL;
const schema = `cumulative_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let delivery: typeof import('./delivery.js');
let threads: typeof import('./thread-updates.js');
let text: typeof import('./text-delivery.js');
let updates: typeof import('./updates.js');
let settings: import('../settings.js').AppSettings;
let api: BotApi;
const content: PublicationSnapshot = { headline: 'Полная новость', details: 'Все необходимые факты', score: 8, detailsKind: 'summary', sources: [] };
const postUrl = (messageId: string) => `https://t.me/c/123/${messageId}`;
const previous = (messageId: string) => ({ label: `Публикация ${messageId}`, url: postUrl(messageId), primary: false,
  access: 'public' as const, classification: 'relevant' as const, previousPublication: true as const });
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Fixture missing');
  return row.id;
}
async function load(id: string, edit = false): Promise<Publication> {
  const row = (await database.db.query<Publication>(`${edit ? store.publicationEditSelect : store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!row) throw new Error('Publication missing');
  return row;
}
async function published(messageId: string, ancestors: string[] = [], album = false): Promise<string> {
  const snapshot = { ...content, sources: ancestors.map(previous), ...(album ? { details: 'Длинные факты '.repeat(300) } : {}) };
  const storyId = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  for (const ancestor of ancestors) await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version)
    SELECT least($1::uuid,p.story_id),greatest($1::uuid,p.story_id),'same','fixture' FROM publications p WHERE p.message_id=$2
    ON CONFLICT DO NOTHING`,[storyId,ancestor]);
  const snapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(snapshot)]);
  const id = await one(`INSERT INTO publications(snapshot_id,destination_id,bot_id,status,message_id,published_at,delivery_kind,story_id)
    VALUES($1,'-100123','123','published',$2,now()+$3::int*interval '1 second',$4,$5) RETURNING id`,[snapshotId,messageId,Number(messageId),album ? 'album' : 'text',storyId]);
  if (!album) await database.db.query(`INSERT INTO publication_text_parts(publication_id,snapshot_id,part_number,content,status,message_id)
    VALUES($1,$2,0,$3,'sent',$4)`,[id,snapshotId,JSON.stringify(renderFullText(snapshot)[0]),messageId]);
  return id;
}
async function prepared(details = content.details): Promise<Publication> {
  const storyId = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,$2,8,true,false,$3,$4) RETURNING id`,[content.headline,details,settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings,[storyId]);
  const [id] = await store.prepareDigest(settings,'-100123',{ storyIds: [storyId] });
  if (!id) throw new Error('Prepared publication missing');
  return load(id);
}
async function mark(): Promise<void> {
  await threads.prepareThreadUpdates('-100123');
  await updates.retryEdits(api,settings,'-100123');
}
async function textParts(id: string) {
  return (await database.db.query<{ part_number: number; status: string; message_id: string | null; content: { plainText: string } }>(
    'SELECT * FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number',[id])).rows;
}

describe.skipIf(!url)('cumulative publication delivery in PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js'); delivery = await import('./delivery.js'); threads = await import('./thread-updates.js');
    text = await import('./text-delivery.js'); updates = await import('./updates.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE publications,publication_snapshots,stories,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    await store.saveState('telegram_destination',{ channelId: '-100123' });
    api = new BotApi('123:synthetic');
    vi.spyOn(api,'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.spyOn(api,'edit').mockResolvedValue(undefined);
    vi.spyOn(api,'editCaption').mockResolvedValue(undefined);
    media.publicationMedia.mockReset().mockResolvedValue([]);
    media.releaseStoryMedia.mockReset().mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('points every ancestor in a three-post chain to the newest actual URL after source retention', async () => {
    const first = await published('10');
    const second = await published('20',['10']);
    await mark();
    expect((await load(first)).content).toMatchObject({ updatedTo: postUrl('20') });
    await database.db.query('DELETE FROM story_mentions');
    const third = await published('30',['10','20']);
    await mark();
    for (const id of [first,second]) expect((await load(id)).content).toMatchObject({ updatedTo: postUrl('30') });
    expect((await load(third)).content).not.toHaveProperty('updatedTo');
    expect((await load(first)).story_id).not.toBeNull();
    expect((await load(first)).content).toMatchObject({ headline: content.headline, details: content.details });
    const count = vi.mocked(api.edit).mock.calls.length;
    await mark();
    expect(api.edit).toHaveBeenCalledTimes(count);
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(3);
  });

  it.each(['text','media'] as const)('does not point to a newer post with incomplete %s delivery', async kind => {
    const first = await published('10'); const second = await published('20',['10']);
    if (kind === 'text') await database.db.query(`INSERT INTO publication_text_parts(publication_id,snapshot_id,part_number,content)
      SELECT id,snapshot_id,1,'{}'::jsonb FROM publications WHERE id=$1`,[second]);
    else {
      await database.db.query("UPDATE publications SET media_status='pending' WHERE id=$1",[second]);
      await database.db.query('INSERT INTO publication_media_batches(publication_id,batch_number) VALUES($1,0)',[second]);
    }
    await mark(); expect(api.edit).not.toHaveBeenCalled(); expect((await load(first)).pending_snapshot_id).toBeNull();
    if (kind === 'text') await database.db.query("UPDATE publication_text_parts SET status='sent',message_id='21' WHERE publication_id=$1 AND part_number=1",[second]);
    else {
      await database.db.query("UPDATE publication_media_batches SET status='sent' WHERE publication_id=$1",[second]);
      await database.db.query("UPDATE publications SET media_status='complete' WHERE id=$1",[second]);
    }
    await mark(); expect((await load(first)).content).toMatchObject({ updatedTo: postUrl('20') });
  });

  it('reconciles the attempted marker before staging a newer target and never blindly repeats an unknown edit', async () => {
    const first = await published('10'); await published('20',['10']);
    vi.mocked(api.edit).mockRejectedValueOnce(new BotError('telegram_transport_unknown','unknown'));
    await mark(); const attempted = await load(first,true);
    await published('30',['10','20']);
    await mark();
    expect((await load(first,true)).pending_snapshot_id).toBe(attempted.pending_snapshot_id);
    const { reconcileUnknownEdit } = await import('./edit-reconciliation.js');
    const { sendMetadata } = await import('./reconciliation.js');
    const { renderPublication } = await import('./message-render.js');
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second' WHERE publication_id=$1",[first]);
    const fingerprint = sendMetadata(await renderPublication(attempted)).fingerprint;
    expect(await reconcileUnknownEdit(attempted,async () => fingerprint)).toBe(true);
    await mark();
    expect((await load(first)).content).toMatchObject({ updatedTo: postUrl('30') });
    expect(vi.mocked(api.edit).mock.calls.filter(call => call[1] === '10')).toHaveLength(2);
  });

  it('keeps the bot cooldown while replacing a known rejected marker with the newest target', async () => {
    const first = await published('10'); await published('20',['10']);
    vi.mocked(api.edit).mockRejectedValueOnce(new BotError('telegram_rate_limit','retryable',120_000));
    await mark(); await published('30',['10','20']);
    await threads.prepareThreadUpdates('-100123');
    expect(await store.rateLimited()).toBe(true);
    expect((await load(first,true)).content).toMatchObject({ updatedTo: postUrl('30') });
    expect((await database.db.query("SELECT status,error_code FROM request_attempts WHERE publication_id=$1 AND operation='edit'",[first])).rows)
      .toEqual([{ status: 'failed',error_code: 'telegram_rate_limit' }]);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    await mark(); expect((await load(first)).content).toMatchObject({ updatedTo: postUrl('30') });
    expect(vi.mocked(api.edit).mock.calls.filter(call => call[1] === '10')).toHaveLength(2);
  });

  it('refuses to shorten a full legacy album caption merely to add a marker', async () => {
    const first = await published('10',[],true); const sent = await load(first);
    await published('20',['10']);
    await mark();
    expect(vi.mocked(api.editCaption).mock.calls[0]?.[2].plainText).toBe(renderCaption(sent.content).plainText);
    expect((await database.db.query('SELECT content FROM publication_navigation_parts WHERE publication_id=$1',[first])).rows[0]?.content.plainText).toContain('UPD: '+postUrl('20'));
    expect(renderCaption(sent.content).plainText.length).toBeGreaterThan(900);
    expect((await load(first)).content).toMatchObject({ details: 'Длинные факты '.repeat(300) });
  });

  it('sends complete text before all 24 distinct native and document media without a ten-total drop', async () => {
    const items: PublicationMedia[] = Array.from({ length: 24 }, (_, index) => ({ type: index > 20 ? 'video' : 'image',
      mimeType: index > 20 ? 'video/webm' : 'image/png', data: Buffer.from(`Original bytes ${index}`) }));
    media.publicationMedia.mockResolvedValue([...items,items[0]]);
    const preparedPublication = await prepared('Полные факты 😀 '.repeat(800));
    // Historical snapshots keep text-first delivery and their uncapped attachment plan.
    await database.db.query("UPDATE publication_snapshots SET content=content-'presentationVersion' WHERE id=$1",[preparedPublication.snapshot_id]);
    const publication = await load(preparedPublication.id);
    let next = 100;
    const send = vi.spyOn(api,'send').mockImplementation(async () => String(next++));
    const attachment = vi.spyOn(api,'sendMedia').mockImplementation(async (_destination,replyTo,batch) => {
      expect(replyTo).toBe('100');
      expect((await textParts(publication.id)).every(part => part.status === 'sent')).toBe(true);
      return batch.map(() => String(next++));
    });
    expect(await delivery.sendPrepared(publication,api,settings)).toBe('100');
    expect(send.mock.calls.length).toBeGreaterThan(1);
    expect(send.mock.calls.slice(1).every(call => call[2] === '100')).toBe(true);
    expect(attachment.mock.calls.map(call => call[2].length)).toEqual([10,10,1,3]);
    expect(attachment.mock.calls.flatMap(call => call[2])).toEqual(items);
    expect((await load(publication.id)).media_status).toBe('complete');
    expect((await database.db.query('SELECT data FROM publication_media_items')).rows.every(item => item.data === null)).toBe(true);
  });

  it('delivers every one of 125 source links in the frozen text plan without a source cap', async () => {
    let publication = await prepared();
    await database.db.query(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      SELECT 'https://complete.example/'||n,'Документ '||n,'Successfully read source facts','public',now()+interval '1 day' FROM generate_series(1,125) n`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at)
      SELECT $1,id,'supporting','relevant',now() FROM evidence_documents WHERE url LIKE 'https://complete.example/%'`,[publication.story_id]);
    if (!publication.story_id) throw new Error('Story missing');
    await acceptFixtureStories(settings,[publication.story_id]);
    await store.refreshPrepared(publication,settings); publication = await load(publication.id);
    const send = vi.spyOn(api,'send').mockImplementation(async () => String(100+send.mock.calls.length));
    expect(await delivery.sendPrepared(publication,api,settings)).not.toBeNull();
    const urls = send.mock.calls.flatMap(call => call[1].links.map(link => link.url));
    expect(new Set(urls).size).toBe(125);
    expect(urls.sort()).toEqual(Array.from({ length: 125 },(_,index) => `https://complete.example/${index+1}`).sort());
    expect((await textParts(publication.id)).every(part => part.status === 'sent')).toBe(true);
  });

  it('deletes tracked continuation replies before the canonical text and retains deletion progress', async () => {
    const publication = await prepared('Полные факты 😀 '.repeat(700));
    let sequence = 100;
    vi.spyOn(api,'send').mockImplementation(async () => String(sequence++));
    await delivery.sendPrepared(publication,api,settings);
    const sent = await load(publication.id);
    const parts = await textParts(publication.id);
    const remove = vi.spyOn(api,'delete').mockResolvedValue(undefined);
    const { deletePublicationMessages } = await import('./media-delivery.js');
    await deletePublicationMessages(sent,api);
    expect(remove.mock.calls.map(call => call[1])).toEqual([...parts.slice(1).map(part => part.message_id),sent.message_id]);
    const count = remove.mock.calls.length;
    await deletePublicationMessages(sent,api); expect(remove).toHaveBeenCalledTimes(count);
  });

  it.each(['retryable','unknown','running'] as const)('preserves frozen text and avoids duplicate canonical sends after a %s continuation', async outcome => {
    const publication = await prepared('Факты 😀 '.repeat(1400));
    const send = vi.spyOn(api,'send').mockResolvedValueOnce('100').mockRejectedValueOnce(new BotError(
      outcome === 'retryable' ? 'telegram_rate_limit' : 'telegram_transport_unknown',outcome === 'retryable' ? 'retryable' : 'unknown',1000));
    expect(await delivery.sendPrepared(publication,api,settings)).toBeNull();
    const initial = await textParts(publication.id);
    expect(initial[0]).toMatchObject({ status: 'sent', message_id: '100' });
    if (outcome === 'running') {
      await database.db.query("UPDATE publication_text_parts SET status='running' WHERE publication_id=$1 AND part_number=1",[publication.id]);
      await database.db.query("UPDATE request_attempts SET status='running' WHERE publication_id=$1 AND operation='send_part:1'",[publication.id]);
    }
    await text.recoverPublicationText('-100123');
    await database.db.query("UPDATE publication_text_parts SET next_retry_at=now()-interval '1 second' WHERE publication_id=$1",[publication.id]);
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second' WHERE publication_id=$1",[publication.id]);
    send.mockImplementation(async () => String(200+send.mock.calls.length));
    await text.retryPublicationText(api,settings,'-100123');
    const after = await textParts(publication.id);
    expect(after.map(part => part.content)).toEqual(initial.map(part => part.content));
    if (outcome === 'retryable') expect(after.every(part => part.status === 'sent')).toBe(true);
    else {
      expect(after[1]?.status).toBe('unknown'); expect(send).toHaveBeenCalledTimes(2);
      const { deletePublicationMessages } = await import('./media-delivery.js');
      await expect(deletePublicationMessages(await load(publication.id),api)).rejects.toMatchObject({ code: 'publication_text_requires_review' });
    }
    expect(send.mock.calls.filter(call => call[2] === undefined)).toHaveLength(1);
  });
});
