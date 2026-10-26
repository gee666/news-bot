import { randomUUID } from 'node:crypto';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import type { AppSettings } from '../settings.js';
const url = process.env.TEST_DATABASE_URL;
const schema = `news_order_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let sourceId: string;
let serial = 0;
const sent: string[] = [];
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function story(headline: string, id: string, created: string) {
  await database.db.query(`INSERT INTO stories(id,status,headline,summary,interest_score,researched,interest_stale,profile_version,model_version,created_at)
    VALUES($1,'completed',$2,'Проверенные подробности',3,true,false,$3,$4,$5)`, [id, headline, settings.profileVersion, settings.modelVersion, created]);
  return id;
}
async function source(storyId: string, published: string | null, collected: string, classification?: 'relevant' | 'irrelevant') {
  const item = await one('INSERT INTO source_items(source_id,external_id,published_at,collected_at) VALUES($1,$2,$3,$4) RETURNING id',
    [sourceId, String(++serial), published, collected]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Source text','Source text') RETURNING id`, [item, String(serial)]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  if (classification) {
    const link = await one('INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id', [revision, `https://example.org/${serial}`]);
    await database.db.query(`INSERT INTO story_link_sources(story_id,link_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,$3,'fixture',1,'fixture','fixture')`, [storyId, link, classification]);
  } else await database.db.query('INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,$3,0)', [storyId, revision, `Source ${serial}`]);
  return { item, revision };
}
describe.skipIf(!url)('chronological new publications with PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:synthetic');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true });
    sourceId = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed','fixture','Fixture','public') RETURNING id");
    await database.db.query(`INSERT INTO operational_state(key,value) VALUES('telegram_destination','{"channelId":"-100123"}'),
      ('bot_verified','{"verified":true,"destinationId":"-100123","botId":123}')`);
    vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.spyOn(BotApi.prototype, 'send').mockImplementation(async (_destination, message) => { sent.push(message.text); return String(sent.length); });
    vi.spyOn(BotApi.prototype, 'edit').mockResolvedValue(undefined);
  });
  afterAll(async () => {
    vi.restoreAllMocks(); if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('sends oldest relevant source news first, ignoring UUID, processing time, irrelevant and obsolete input', async () => {
    const old = await story('Первая новость', '00000000-0000-4000-8000-000000000004', '2026-09-30');
    const fallback = await story('Вторая новость', '00000000-0000-4000-8000-000000000003', '2026-09-29');
    const linked = await story('Третья новость', '00000000-0000-4000-8000-000000000002', '2026-09-28');
    const latest = await story('Четвертая новость', '00000000-0000-4000-8000-000000000001', '2026-09-27');
    await source(old, '2026-09-20', '2026-09-30');
    const unknown = await source(fallback, null, '2026-09-21');
    await database.db.query("UPDATE source_items SET collected_at='2026-09-30' WHERE id=$1", [unknown.item]); // Refetch cannot move first collection.
    await source(linked, '2026-09-22', '2026-09-30', 'relevant');
    await source(latest, '2026-09-23', '2026-09-30');
    await source(latest, '2020-01-01', '2026-09-30', 'irrelevant');
    const obsolete = await source(latest, '2021-01-01', '2026-09-30');
    await database.db.query('UPDATE source_items SET current_revision_id=NULL WHERE id=$1', [obsolete.item]);
    await database.db.query("UPDATE stories SET status='completed',interest_stale=false WHERE id=$1", [latest]);
    const { prepareDigest } = await import('./store.js');
    await acceptFixtureStories(settings);
    await prepareDigest(settings, '-100123');
    // Preparation in one transaction gives equal created_at; send order must not depend on it or random publication IDs.
    await database.db.query("UPDATE publications SET created_at='2025-01-01'");
    await (await import('./digest.js')).publishDigest(settings);
    expect(sent).toHaveLength(4);
    for (const [index, title] of ['Первая новость', 'Вторая новость', 'Третья новость', 'Четвертая новость'].entries()) {
      expect(sent[index]).toContain(title);
    }
  }, 60_000);
  it('does not silently edit sources of an already published story', async () => {
    const original = (await database.db.query<{ id: string; snapshot_id: string }>("SELECT id,snapshot_id FROM publications WHERE story_id='00000000-0000-4000-8000-000000000004'")).rows[0];
    if (!original) throw new Error('Missing publication');
    await database.db.query("UPDATE stories SET headline='Первая новость с уточнением',summary='Уточненные факты' WHERE id='00000000-0000-4000-8000-000000000004'");
    const evidence=await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES('https://new.example/report','New report','Read report details','public',now()+interval '1 day') RETURNING id`);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES('00000000-0000-4000-8000-000000000004',$1,'supporting','relevant',now())",[evidence]);
    await acceptFixtureStories(settings);
    // Existing-post corrections are prepared by accepted ready events, not a history sweep.
    await (await import('./updates.js')).prepareUpdates(settings, '-100123', ['00000000-0000-4000-8000-000000000004']);
    await (await import('./digest.js')).publishDigest(settings);
    expect(sent).toHaveLength(4); expect(BotApi.prototype.edit).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT count(*)::int AS count FROM publications')).rows[0]?.count).toBe(4);
    expect((await database.db.query('SELECT id,status,snapshot_id FROM publications WHERE id=$1', [original.id])).rows[0])
      .toMatchObject({ id: original.id, status: 'published', snapshot_id: original.snapshot_id });
    expect((await database.db.query('SELECT content FROM publication_snapshots WHERE id=$1', [original.snapshot_id])).rows[0]?.content.headline).toBe('Первая новость');
  });
});
