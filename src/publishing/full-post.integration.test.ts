import { randomUUID } from 'node:crypto';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotError } from './bot-api.js';
import type { PublicationSnapshot } from '../types.js';
import { render } from './render.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `fullpost_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let updates: typeof import('./updates.js');
let delivery: typeof import('./delivery.js');
let repair: typeof import('./repair.js');
let store: typeof import('./store.js');
let settings: import('../settings.js').AppSettings;
const oldContent: PublicationSnapshot = { headline: 'Раньше', details: 'Старые детали', score: 3, detailsKind: 'summary', sources: [] };
const newContent: PublicationSnapshot = { headline: 'Новая модель', details: 'Полное описание', score: 8, detailsKind: 'summary', sources: [],
  review: { supported: true, reason: 'Существенных ошибок не найдено' } };
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Fixture missing');
  return row.id;
}
async function story(): Promise<string> {
  const id = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,$2,$3,true,false,$4,$5) RETURNING id`,
  [newContent.headline,newContent.details,newContent.score,settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings);
  return id;
}
async function publication(storyId: string, messageId: string, botId = '123'): Promise<string> {
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [storyId,JSON.stringify(oldContent)]);
  return one(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,status,bot_id)
    VALUES($1,$2,'-100123',$3,'published',$4) RETURNING id`, [storyId,snapshot,messageId,botId]);
}
async function row(id: string): Promise<import('./store.js').Publication> {
  const value = (await database.db.query<import('./store.js').Publication>(`${store.publicationSelect} WHERE p.id=$1`,[id])).rows[0];
  if (!value) throw new Error('Publication missing');
  return value;
}
async function mergedPair(): Promise<{ canonical: string; duplicate: string }> {
  const canonicalStory = await story(); const duplicateStory = await story();
  const canonical = await publication(canonicalStory,'5'); const duplicate = await publication(duplicateStory,'6');
  await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[duplicateStory,canonicalStory]);
  await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[duplicateStory]);
  return { canonical,duplicate };
}

describe.skipIf(!url)('full-post durable PostgreSQL publishing', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    updates = await import('./updates.js'); delivery = await import('./delivery.js'); repair = await import('./repair.js'); store = await import('./store.js');
    await store.saveState('telegram_destination',{ channelId: '-100123',inviteUrl: 'https://t.me/+synthetic' });
    await store.saveState('bot_verified',{ verified: true,destinationId: '-100123',botId: 123 });
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id: 123,is_bot: true });
    vi.spyOn(BotApi.prototype,'send').mockRejectedValue(new Error('Live sends forbidden in tests'));
    await database.db.query('TRUNCATE publication_replacements,request_attempts,publications,publication_snapshots,story_merges,stories CASCADE');
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('stages immutable details, edits one existing message and switches the snapshot only after success', async () => {
    const id = await publication(await story(),'5'); const previous = await row(id);
    await updates.prepareUpdates(settings,'-100123');
    const staged = await row(id); expect(staged.snapshot_id).toBe(previous.snapshot_id); expect(staged.pending_snapshot_id).not.toBeNull();
    expect(staged.content).toEqual(oldContent);
    const edit = vi.spyOn(BotApi.prototype,'edit').mockImplementation(async (_destination,messageId,message) => {
      expect(messageId).toBe('5'); expect(message.reply_markup.inline_keyboard).toEqual([]);
      expect(message.text).toContain(newContent.details); expect((await row(id)).content).toEqual(oldContent);
    });
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    expect(edit).toHaveBeenCalledOnce(); expect((await row(id)).content).toEqual(newContent);
    expect((await row(id)).pending_snapshot_id).toBeNull(); expect((await row(id)).format_version).toBe(1);
    await updates.prepareUpdates(settings,'-100123'); expect((await row(id)).pending_snapshot_id).toBeNull();
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
  });
  it('retains an unknown edit for review after raw-history cleanup instead of blindly retrying it', async () => {
    const id = await publication(await story(),'5'); await updates.prepareUpdates(settings,'-100123');
    const edit = vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect((await row(id)).content).toEqual(oldContent);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0); expect(edit).toHaveBeenCalledOnce();
    await database.db.query('DELETE FROM stories');
    await database.db.query("UPDATE request_attempts SET next_retry_at=now()-interval '1 second'");
    edit.mockResolvedValue(undefined);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(0);
    expect(edit).toHaveBeenCalledOnce();
    expect((await row(id)).story_id).toBeNull(); expect((await row(id)).content).toEqual(oldContent);
    expect((await database.db.query("SELECT status FROM request_attempts WHERE operation='edit'")).rows).toEqual([{ status:'unknown' }]);
  });
  it('trims oversized revisions for Telegram while retaining the full immutable snapshot', async () => {
    const storyId = await story(); const id = await publication(storyId,'5');
    const summary = '😀'.repeat(3000);
    await database.db.query('UPDATE stories SET summary=$1 WHERE id=$2',[summary,storyId]);
    await acceptFixtureStories(settings);
    const edit = vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
    await updates.prepareUpdates(settings,'-100123');
    expect((await row(id)).content).toEqual(oldContent);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    expect(edit).toHaveBeenCalledOnce();
    const message = edit.mock.calls[0]?.[2];
    expect(message?.plainText.length).toBeLessThanOrEqual(4096);
    expect(message?.plainText).toContain('😀'); expect(message?.plainText).toMatch(/…$/u);
    expect((await row(id)).content).toEqual({ ...newContent, details: summary });
    expect((await row(id)).pending_snapshot_id).toBeNull();
    expect((await database.db.query('SELECT status,error_code FROM request_attempts')).rows).toEqual([{ status: 'succeeded', error_code: null }]);
  });
  it('does not delete duplicates when the canonical edit fails', async () => {
    await mergedPair(); vi.spyOn(BotApi.prototype,'edit').mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
    const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 0,deleted: 0 });
    expect(remove).not.toHaveBeenCalled(); expect((await database.db.query('SELECT * FROM publication_replacements')).rows).toHaveLength(0);
  });
  it('persists replacement authorization only after canonical edit and retries unknown deletion idempotently', async () => {
    const { canonical,duplicate } = await mergedPair();
    const edit = vi.spyOn(BotApi.prototype,'edit').mockImplementation(async () => {
      expect((await database.db.query('SELECT * FROM publication_replacements')).rows).toHaveLength(0);
    });
    const remove = vi.spyOn(BotApi.prototype,'delete').mockImplementation(async (destination,messageId) => {
      expect(destination).toBe('-100123'); expect(messageId).toBe('6');
      expect((await row(canonical)).content).toEqual(newContent);
      expect((await database.db.query('SELECT * FROM publication_replacements')).rows).toHaveLength(1);
      throw new BotError('telegram_transport_unknown','unknown');
    });
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 1,deleted: 0 });
    expect(remove).toHaveBeenCalledOnce();
    const successfulSnapshot = (await row(canonical)).snapshot_id;
    edit.mockClear();
    await database.db.query("UPDATE publication_replacements SET next_retry_at=now()-interval '1 second'");
    remove.mockResolvedValue(undefined);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 0,deleted: 1 });
    expect(edit).not.toHaveBeenCalled(); expect((await row(canonical)).snapshot_id).toBe(successfulSnapshot);
    expect((await database.db.query('SELECT status FROM publication_replacements WHERE duplicate_publication_id=$1',[duplicate])).rows).toEqual([{ status: 'deleted' }]);
    expect(await repair.retryReplacements(new BotApi(),settings,'-100123')).toBe(0);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('skips unchanged full canonical edits but authorizes newly tracked duplicates after the previous successful edit', async () => {
    const canonicalStory = await story(); const canonical = await publication(canonicalStory,'5');
    const edit = vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
    const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 1,deleted: 0 });
    const successful = await row(canonical); expect(successful.format_version).toBe(1); expect(successful.pending_snapshot_id).toBeNull();
    const loser = await story(); const duplicate = await publication(loser,'6');
    await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[loser,canonicalStory]);
    await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[loser]);
    edit.mockClear();
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 0,deleted: 1 });
    expect(edit).not.toHaveBeenCalled(); expect(remove).toHaveBeenCalledExactlyOnceWith('-100123','6');
    expect((await row(canonical)).snapshot_id).toBe(successful.snapshot_id);
    expect((await database.db.query('SELECT canonical_snapshot_id,status FROM publication_replacements WHERE duplicate_publication_id=$1',[duplicate])).rows)
      .toEqual([{ canonical_snapshot_id: successful.snapshot_id,status: 'deleted' }]);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('never deletes another bot or destination, and alias rows prevent a second send', async () => {
    const { canonical,duplicate } = await mergedPair();
    await database.db.query("UPDATE publications SET bot_id='456' WHERE id=$1",[duplicate]);
    vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined); const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 1,deleted: 0 }); expect(remove).not.toHaveBeenCalled();
    await store.prepareDigest(settings,'-100123');
    expect((await database.db.query('SELECT id FROM publications')).rows.map(value => value.id).sort()).toEqual([canonical,duplicate].sort());
  });
  it('repairs only tracked duplicate aliases even after retention nulls their story ID', async () => {
    const { canonical,duplicate } = await mergedPair();
    const canonicalStory = (await row(canonical)).story_id; const duplicateStory = (await row(duplicate)).story_id;
    await database.db.query(`INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id)
      VALUES($1,$2,$2),($3,$4,$2)`,[canonical,canonicalStory,duplicate,duplicateStory]);
    await database.db.query('DELETE FROM stories WHERE id=$1',[duplicateStory]);
    expect((await row(duplicate)).story_id).toBeNull();
    vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined); const remove = vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 1,deleted: 1 });
    expect(remove).toHaveBeenCalledWith('-100123','6');
    await store.prepareDigest(settings,'-100123'); expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(2);
  });
  it('preserves historical snapshots but does not reuse archived evidence without current successful reading and assessment', async () => {
    const { canonical,duplicate } = await mergedPair();
    const canonicalStory = (await row(canonical)).story_id;
    const duplicateStory = (await row(duplicate)).story_id;
    const oldSource = { label: 'Первый канал',url: 'https://t.me/first/1',primary: false,access: 'public',classification: 'relevant' };
    await database.db.query('UPDATE publication_snapshots SET content=$1 WHERE id=$2',[
      JSON.stringify({ ...oldContent,sources: [oldSource] }),(await row(duplicate)).snapshot_id]);
    const evidence = await one(`INSERT INTO evidence_documents(url,title,access,expires_at)
      VALUES('https://author.org/old','Старое заявление','public',now()+interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_merge_evidence(merged_story_id,canonical_story_id,evidence_id,role,verified_at)
      VALUES($1,$2,$3,'primary',now())`,[duplicateStory,canonicalStory,evidence]);
    await updates.prepareUpdates(settings,'-100123');
    const content = (await database.db.query<{ content: PublicationSnapshot }>(`${store.publicationEditSelect} WHERE p.id=$1`,[canonical])).rows[0]?.content;
    expect(content).toEqual(newContent);
    expect((await row(duplicate)).content).toEqual({ ...oldContent,sources: [oldSource] });
    expect((await database.db.query('SELECT evidence_id FROM story_merge_evidence WHERE evidence_id=$1',[evidence])).rows).toHaveLength(1);
  });
  it('publishes all 17 actually read assessed documents before both Telegram origins without raw anchors or ads', async () => {
    const { canonical,duplicate } = await mergedPair();
    const canonicalStory = (await row(canonical)).story_id;
    const urls = Array.from({ length: 17 }, (_, index) => `https://external.org/article/${index}`);
    for (const channel of [0,1]) {
      const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
        VALUES('telegram',$1,$2,'public') RETURNING id`, [`-100${300+channel}`,`Канал ${channel}`]);
      const item = await one(`INSERT INTO source_items(source_id,external_id,original_url)
        VALUES($1,'1',$2) RETURNING id`, [source,`https://t.me/channel${channel}/1`]);
      const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
        VALUES($1,1,'hash','news','news') RETURNING id`, [item]);
      await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,item]);
      const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
        VALUES($1,$2,'news',0) RETURNING id`, [canonicalStory,revision]);
      const selected = channel === 0 ? urls.slice(0,9) : [urls[0]!,...urls.slice(9)];
      for (const linkUrl of [...selected,'https://ads.org']) {
        const label = linkUrl === urls[0] ? `Документ из канала ${channel}` : `Статья ${linkUrl.split('/').at(-1)}`;
        const link = await one('INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,$3) RETURNING id',[revision,linkUrl,label]);
        const classification = linkUrl === 'https://ads.org' ? 'irrelevant' : linkUrl === urls[16] ? 'uncertain' : 'relevant';
        await database.db.query('INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,$3)',[mention,link,classification]);
      }
    }
    for (const [index,target] of urls.entries()) {
      const evidence = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
        VALUES($1,'Документ','Actual successfully read event document','public',now()+interval '1 day') RETURNING id`,[target]);
      await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at)
        VALUES($1,$2,$3,'relevant',now())`,[canonicalStory,evidence,index === 0 ? 'primary' : 'supporting']);
    }
    const oldAd = { label: 'Старая реклама',url: 'https://ads.org',primary: false,access: 'unknown',classification: 'relevant' };
    await database.db.query('UPDATE publication_snapshots SET content=$1 WHERE id=$2',[
      JSON.stringify({ ...oldContent,sources: [oldAd] }),(await row(duplicate)).snapshot_id]);
    await acceptFixtureStories(settings);
    await updates.prepareUpdates(settings,'-100123');
    const content = (await database.db.query<{ content: PublicationSnapshot }>(`${store.publicationEditSelect} WHERE p.id=$1`,[canonical])).rows[0]?.content;
    if (!content) throw new Error('Prepared snapshot missing');
    expect(content.sources).toHaveLength(19); expect(content.sources.slice(0,17).map(source => source.url).sort()).toEqual([...urls].sort());
    expect(content.sources[0]).toMatchObject({ url: urls[0],primary: true });
    expect(content.sources.find(source => source.url === urls[1])).toMatchObject({ primary: false,classification: 'relevant' });
    expect(content.sources[0]?.label).toBe('Документ');
    expect(content.sources.find(source => source.url === urls[16])?.classification).toBe('relevant');
    const message = render(content);
    expect(message.links).toHaveLength(19);
    for (const linkUrl of urls) expect(message.text).toContain(linkUrl);
    expect(message.text).not.toContain('ads.org'); expect(message.text).not.toContain('не проверено');
    expect(message.text).toContain('<b>Первоисточники</b>');
    expect(message.text).toContain('<b>Вторичные источники</b>');
    for (const link of message.links) expect(message.plainText.slice(link.offset,link.offset+link.length)).not.toBe('');
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('uses the read document title rather than historical anchors through edits, repeated repairs and an alias chain', async () => {
    const { canonical,duplicate } = await mergedPair();
    const canonicalStory = (await row(canonical)).story_id; const loserStory = (await row(duplicate)).story_id;
    const sharedUrl = 'https://publisher.org/shared';
    const source = { url: sharedUrl,primary: false,access: 'unknown' as const,classification: 'relevant' as const };
    await database.db.query('UPDATE publication_snapshots SET content=$1 WHERE id=$2',[
      JSON.stringify({ ...oldContent,sources: [{ ...source,label: 'Mutable feedback / repeated output' }] }),(await row(canonical)).snapshot_id]);
    await database.db.query('UPDATE publication_snapshots SET content=$1 WHERE id=$2',[
      JSON.stringify({ ...oldContent,sources: [{ ...source,label: 'Older / alias' }] }),(await row(duplicate)).snapshot_id]);
    await database.db.query(`INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id)
      VALUES($1,$2,$2),($3,$4,$2)`,[canonical,canonicalStory,duplicate,loserStory]);
    for (const [index,label] of ['Research / lab','Vendor'].entries()) {
      const sourceId = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram',$1,'Label fixture','public') RETURNING id",[`-100${800 + index}`]);
      const item = await one("INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,'1',$2) RETURNING id",[sourceId,`https://t.me/labels${index}/1`]);
      const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
        VALUES($1,1,'labels','News facts','News facts') RETURNING id`,[item]);
      await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,item]);
      const mention = await one("INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,'News facts',0) RETURNING id",[canonicalStory,revision]);
      const link = await one('INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,$3) RETURNING id',[revision,sharedUrl,label]);
      await database.db.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')",[mention,link]);
    }
    async function desired(storyId: string | null): Promise<PublicationSnapshot> {
      const current = (await database.db.query<import('./store.js').StoryContent>('SELECT * FROM stories WHERE id=$1',[storyId])).rows[0];
      if (!current) throw new Error('Canonical fixture missing'); return store.snapshotFor(database.db,current);
    }
    const document = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES($1,'Actual document title','Read actual event facts','public',now()+interval '1 day') RETURNING id`,[sharedUrl]);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[canonicalStory,document]);
    await acceptFixtureStories(settings);
    const before = await desired(canonicalStory);
    expect(before.sources.find(link => link.url === sharedUrl)?.label).toBe('Actual document title');
    expect(JSON.stringify(before)).not.toContain('Mutable feedback');
    await acceptFixtureStories(settings);
    const edit = vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
    vi.spyOn(BotApi.prototype,'delete').mockResolvedValue(undefined);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 1,deleted: 1 });
    expect(await desired(canonicalStory)).toEqual(before); expect((await row(canonical)).content).toEqual(before);
    edit.mockClear();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 0,deleted: 0 });
      expect(await desired(canonicalStory)).toEqual(before);
    }
    expect(edit).not.toHaveBeenCalled();
    const nextStory = await story();
    await database.db.query("UPDATE story_merges SET canonical_story_id=$1 WHERE canonical_story_id=$2",[nextStory,canonicalStory]);
    await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[canonicalStory,nextStory]);
    await database.db.query('UPDATE story_publication_aliases SET canonical_story_id=$1 WHERE canonical_story_id=$2',[nextStory,canonicalStory]);
    await database.db.query('UPDATE story_mentions SET story_id=$1 WHERE story_id=$2',[nextStory,canonicalStory]);
    await database.db.query('UPDATE story_evidence SET story_id=$1 WHERE story_id=$2',[nextStory,canonicalStory]);
    await database.db.query("UPDATE stories SET status='rejected' WHERE id=$1",[canonicalStory]);
    expect((await desired(nextStory)).sources).toEqual(before.sources);
    await acceptFixtureStories(settings);
    expect(await repair.repairExistingPublications(settings)).toEqual({ edited:1,deleted:0 });
    edit.mockClear();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await repair.repairExistingPublications(settings)).toEqual({ edited: 0,deleted: 0 });
      expect(await desired(nextStory)).toEqual(before);
    }
    expect(edit).not.toHaveBeenCalled(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('persists the fingerprint before an unknown send and never retries the send after restart', async () => {
    const id = await publication(await story(),'5');
    await database.db.query("UPDATE publications SET status='prepared',message_id=NULL WHERE id=$1",[id]);
    await store.refreshPrepared(await row(id),settings);
    const send = vi.spyOn(BotApi.prototype,'send').mockImplementation(async () => {
      const attempts = (await database.db.query('SELECT response_metadata,status FROM request_attempts')).rows;
      expect(attempts).toHaveLength(1); expect(attempts[0]?.status).toBe('running');
      expect(attempts[0]?.response_metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
      expect((await row(id)).status).toBe('sending');
      throw new BotError('telegram_transport_unknown','unknown');
    });
    expect(await delivery.sendPrepared(await row(id),new BotApi(),settings)).toBeNull();
    expect((await row(id)).status).toBe('uncertain');
    await (await import('./digest.js')).recoverSends('-100123');
    expect(await delivery.sendPrepared(await row(id),new BotApi(),settings)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    expect(await delivery.reconcile(await row(id),settings,async () => '5')).toBe(true);
    expect((await row(id)).status).toBe('published'); expect((await row(id)).message_id).toBe('5');
  });
  it('never sends an uncertain publication again even when directly invoked', async () => {
    const id = await publication(await story(),'5'); await database.db.query("UPDATE publications SET status='uncertain',message_id=NULL WHERE id=$1",[id]);
    expect(await delivery.sendPrepared(await row(id),new BotApi(),settings)).toBeNull(); expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
});
