import { randomUUID } from 'node:crypto';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import { render } from './render.js';
import type { PublicationSnapshot, PublicationSource } from '../types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `pubsources_${randomUUID().replaceAll('-','')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let updates: typeof import('./updates.js');
let settings: import('../settings.js').AppSettings;
const content: PublicationSnapshot = { headline: 'Новая модель',details: 'Подробное описание',score: 8,detailsKind: 'summary',sources: [] };
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql,values)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function story(): Promise<string> {
  const id = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed',$1,$2,8,true,false,$3,$4) RETURNING id`,[content.headline,content.details,settings.profileVersion,settings.modelVersion]);
  await acceptFixtureStories(settings);
  return id;
}
async function publication(storyId: string, messageId: string, snapshotContent = content): Promise<string> {
  const snapshotId = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',[storyId,JSON.stringify(snapshotContent)]);
  return one(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,status,bot_id)
    VALUES($1,$2,'-100123',$3,'published','123') RETURNING id`,[storyId,snapshotId,messageId]);
}
async function contribution(storyId: string, channel: string, post: string, linkUrl: string,
  classification: PublicationSource['classification'] | 'irrelevant', restricted = false) {
  const origin = restricted ? null : `https://t.me/recaps/${post}`;
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Recaps',$2) RETURNING id`,[channel,restricted ? 'restricted' : 'public']);
  const item = await one('INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,$2,$3) RETURNING id',[source,post,origin]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,'source-only','Все релизы с DevDay','Все релизы с DevDay') RETURNING id`,[item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,item]);
  const link = await one("INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,'Все релизы') RETURNING id",[revision,linkUrl]);
  await associate(storyId,link,classification);
  return { item,revision,link,origin: origin ?? `https://t.me/c/${channel.slice(4)}/${post}` };
}
async function associate(storyId: string, link: string, classification: PublicationSource['classification'] | 'irrelevant'): Promise<void> {
  await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
    VALUES($1,$2,$3,'fixture',$4,'source-only-fixture','fixture')`,[link,storyId,classification,settings.modelVersion]);
}
async function snapshot(storyId: string): Promise<PublicationSnapshot> {
  const row = (await database.db.query<import('./store.js').StoryContent>('SELECT * FROM stories WHERE id=$1',[storyId])).rows[0];
  if (!row) throw new Error('Story missing'); return store.snapshotFor(database.db,row);
}

describe.skipIf(!url)('source-only publication contributions in PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options',`-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL',scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN','123:synthetic');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    store = await import('./store.js'); updates = await import('./updates.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id: 123,is_bot: true });
    vi.spyOn(BotApi.prototype,'send').mockRejectedValue(new Error('Live sends forbidden'));
    await database.db.query('TRUNCATE stories,sources,publications,publication_snapshots,story_merges CASCADE');
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('adds actually read recap URLs and collected public/private origins without inventing a story or primary source', async () => {
    const storyId = await story(); const publicationId = await publication(storyId,'5');
    const recapUrl = 'https://openai.com/ru-RU/index/devday-2026-recap/';
    const publicSource = await contribution(storyId,'-1009401','10052',recapUrl,'relevant');
    const privateSource = await contribution(storyId,'-1009402','10053','https://publisher.org/related','relevant',true);
    for (const target of [recapUrl,'https://publisher.org/related']) {
      const doc = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
        VALUES($1,'Read event recap','Actual event recap text','public',now()+interval '1 day') RETURNING id`,[target]);
      await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES($1,$2,'supporting','relevant',now())",[storyId,doc]);
    }
    await contribution(storyId,'-1009403','10054','https://ads.org/course','irrelevant');
    await contribution(storyId,'-1009404','10055','https://publisher.org/uncertain','uncertain');
    expect((await database.db.query('SELECT id FROM story_mentions')).rows).toHaveLength(0);
    await acceptFixtureStories(settings);
    await updates.prepareUpdates(settings,'-100123',undefined,{ sourceRepair: true });
    const desired = (await database.db.query<{ content: PublicationSnapshot }>(`${store.publicationEditSelect} WHERE p.id=$1`,[publicationId])).rows[0]?.content;
    if (!desired) throw new Error('Desired snapshot missing');
    expect(desired.sources.map(source => source.url).sort()).toEqual([
      recapUrl,'https://publisher.org/related',publicSource.origin,privateSource.origin,
    ].sort());
    expect(desired.sources.every(source => !source.primary)).toBe(true);
    expect(desired.sources.find(source => source.url === 'https://publisher.org/related')?.classification).toBe('relevant');
    expect(desired.sources.find(source => source.url === privateSource.origin)).toMatchObject({ access: 'restricted',classification: 'relevant' });
    const message = render(desired);
    expect(message.links).toHaveLength(4); expect(message.text).toContain('доступ ограничен');
    expect(message.text).not.toContain('publisher.org/uncertain'); expect(message.text).not.toContain('10055');
    expect(message.text).not.toContain('ads.org'); expect(message.text).not.toContain('Первоисточники');
    for (const source of desired.sources) expect(message.links.some(link => link.url === source.url)).toBe(true);
    vi.spyOn(BotApi.prototype,'edit').mockResolvedValue(undefined);
    expect(await updates.retryEdits(new BotApi(),settings,'-100123')).toBe(1);
    await store.prepareDigest(settings,'-100123');
    expect((await database.db.query('SELECT id FROM stories')).rows).toHaveLength(1);
    expect((await database.db.query('SELECT id FROM publications')).rows).toHaveLength(1);
    expect(BotApi.prototype.send).not.toHaveBeenCalled();
  });
  it('keeps snapshots immutable without resurrecting unvisited historical links or withdrawn report origins', async () => {
    const storyId = await story(); const duplicateStory = await story();
    const source = await contribution(storyId,'-1009501','1','https://publisher.org/old','relevant');
    const archived: PublicationSnapshot = { ...content,sources: [
      { label: 'Старая подпись',url: 'https://publisher.org/old',primary: false,access: 'unknown',classification: 'relevant' },
      { label: 'Архивная публикация',url: source.origin,primary: false,access: 'public',classification: 'relevant' },
    ] };
    const duplicate = await publication(duplicateStory,'6',archived);
    await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')",[duplicateStory,storyId]);
    await database.db.query(`INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id)
      VALUES($1,$2,$3)`,[duplicate,duplicateStory,storyId]);
    await database.db.query('DELETE FROM stories WHERE id=$1',[duplicateStory]);
    await acceptFixtureStories(settings);
    expect((await snapshot(storyId)).sources.map(link => link.url)).toEqual([source.origin]);
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,'new-link','Обновлённая ссылка','Обновлённая ссылка') RETURNING id`,[source.item]);
    const link = await one("INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,'https://publisher.org/new','Новая ссылка') RETURNING id",[revision]);
    await associate(storyId,link,'relevant');
    await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[revision,source.item]);
    expect((await snapshot(storyId)).sources.map(link => link.url)).toEqual([source.origin]);
    await acceptFixtureStories(settings);
    const changed = await snapshot(storyId);
    expect(changed.sources.map(source => source.url)).toEqual([source.origin]);
    expect(changed.sources.every(source => source.classification === 'relevant')).toBe(true);
    await database.db.query("UPDATE story_link_sources SET classification='uncertain' WHERE link_id=$1",[link]);
    expect((await snapshot(storyId)).sources).toEqual([]);
    await database.db.query("UPDATE story_link_sources SET classification='relevant' WHERE link_id=$1",[link]);
    const withdrawn = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,3,'withdrawn','Ссылка удалена','Ссылка удалена') RETURNING id`,[source.item]);
    await database.db.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2',[withdrawn,source.item]);
    expect((await snapshot(storyId)).sources).toEqual([]);
    const preserved = (await database.db.query<{ content: unknown }>(`${store.publicationSelect} WHERE p.id=$1`,[duplicate])).rows[0]?.content;
    expect(preserved).toEqual(archived);
  });
});
