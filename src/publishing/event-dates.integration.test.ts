import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BotApi } from './bot-api.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';
import type { AppSettings } from '../settings.js';
import type { Publication, StoryContent } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `event_dates_${randomUUID().replaceAll('-', '')}`;
const now = Date.parse('2026-11-03T08:00:00Z');
const recapUrl = 'https://blog.google/innovation-and-ai/technology/ai/google-ai-updates-october-2026/';
const primaryUrl = 'https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/';
let admin: pg.Pool;
let database: typeof import('../db.js');
let store: typeof import('./store.js');
let admission: typeof import('./input-admission.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Fixture missing'); return row.id;
}
async function addEvidence(story: string, publishedAt: string | null, options: {
  role?: 'primary' | 'supporting'; verified?: boolean; relevance?: 'relevant' | 'irrelevant'; superseded?: boolean;
  status?: number; dateMetadata?: object; evidenceUrl?: string;
} = {}) {
  const id = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at,metadata)
    VALUES($1,'EmbeddingGemma 2 announcement','The embedding model was released with available weights.','public',
      now()-interval '1 day',$2) RETURNING id`, [options.evidenceUrl ?? primaryUrl,
  JSON.stringify({ status: options.status ?? 200, publishedAt, ...options.dateMetadata })]);
  await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at,superseded_at)
    VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() END,CASE WHEN $6 THEN now() END)`,
  [story, id, options.role ?? 'primary', options.relevance ?? 'relevant', options.verified ?? true, options.superseded ?? false]);
  return id;
}
async function fixture(primaryDate: string | null = '2026-10-06T00:00:00.000Z') {
  const story = await one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','EmbeddingGemma 2 released','The embedding model is available.','EmbeddingGemma 2 is available',8,true,false,$1,$2) RETURNING id`,
  [settings.profileVersion, settings.modelVersion]);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('website',$1,'Google blog','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'recap',$2,'2026-11-02T12:00:00Z') RETURNING id`, [source, recapUrl]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
    VALUES($1,1,'monthly-recap','October recap includes EmbeddingGemma 2.','October recap includes EmbeddingGemma 2.',$2) RETURNING id`,
  [item, JSON.stringify({ connectorKind: 'website', canonicalUrl: recapUrl, title: 'Google AI updates in October' })]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  await database.db.query(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
    VALUES($1,$2,'EmbeddingGemma 2 is available',0)`, [story, revision]);
  const evidence = await addEvidence(story, primaryDate);
  await acceptFixtureStories(settings, [story]);
  return { story, evidence, item };
}
/** Capture a boundary independently of digest selection. */
async function prepareDirect(storyId: string): Promise<Publication> {
  const story = (await database.db.query<StoryContent>('SELECT * FROM stories WHERE id=$1', [storyId])).rows[0];
  if (!story) throw new Error('Missing story');
  const content = await store.snapshotFor(database.db, story);
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [storyId, JSON.stringify(content)]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,bot_id)
    VALUES($1,$2,'-100123','123') RETURNING id`, [storyId, snapshot]);
  await database.transaction(client => admission.recordPublicationInputs(client, id, storyId, { newPreparation: true }));
  const pub = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`, [id])).rows[0];
  if (!pub) throw new Error('Missing publication'); return pub;
}

describe.skipIf(!url)('informational primary dates at preparation and dispatch', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('TELEGRAM_BOT_TOKEN', '123:synthetic');
    database = await import('../db.js'); await database.migrate();
    store = await import('./store.js'); admission = await import('./input-admission.js');
  });
  beforeEach(async () => {
    vi.restoreAllMocks(); vi.spyOn(Date, 'now').mockReturnValue(now);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network forbidden')));
    await database.db.query('TRUNCATE sources,stories,evidence_documents,publications,publication_snapshots,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: true, collectionWindowHours: 48 });
    await store.saveState('telegram_destination', { channelId: '-100123' });
    await store.saveState('bot_verified', { verified: true, destinationId: '-100123', botId: 123 });
    vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
    vi.spyOn(BotApi.prototype, 'send').mockResolvedValue('not-actually-sent');
  });
  afterAll(async () => {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it.each(['2026-10-06', '2026-10-08', '2026-10-14', '2026-10-15', '2026-10-27'])(
    'allows the Nov 2 recap of an old %s primary at preparation and mocked send', async date => {
      const f = await fixture(`${date}T00:00:00.000Z`);
      expect(await admission.publicationInputAdmission(f.story, '-100123', settings)).toEqual({ allowed: true });
      const [id] = await store.prepareDigest(settings, '-100123', { storyIds: [f.story] });
      expect(id).toBeDefined();
      const pub = (await database.db.query<Publication>(`${store.publicationSelect} WHERE p.id=$1`, [id])).rows[0];
      if (!pub) throw new Error('Missing publication');
      expect((await admission.preparedPublicationInputs(pub.id))?.primaryEventDates)
        .toEqual([{ evidenceId: f.evidence, url: primaryUrl, publishedAt: `${date}T00:00:00.000Z` }]);
      const { sendPrepared } = await import('./delivery.js');
      expect(await sendPrepared(pub, new BotApi(), settings)).toBe('not-actually-sent');
      expect(BotApi.prototype.send).toHaveBeenCalledOnce();
    });
  it('keeps frozen primary dates unchanged when a fresh primary is attached later', async () => {
    const f = await fixture(); const pub = await prepareDirect(f.story);
    const before = await admission.preparedPublicationInputs(pub.id);
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { evidenceUrl: 'https://example.org/new-primary' });
    expect(await admission.publicationInputAdmission(f.story, '-100123', settings)).toEqual({ allowed: true });
    const { publicationAdmission } = await import('./freshness.js');
    expect(await publicationAdmission(database.db, pub, settings, 'send')).toEqual({ allowed: true });
    expect(await admission.preparedPublicationInputs(pub.id)).toEqual(before);
  });
  it('allows a fresh relevant primary alongside old background and old primary history', async () => {
    const f = await fixture();
    await addEvidence(f.story, '2026-10-06T00:00:00.000Z', { role: 'supporting' });
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { evidenceUrl: 'https://example.org/new-primary' });
    await acceptFixtureStories(settings, [f.story]);
    expect(await store.prepareDigest(settings, '-100123', { storyIds: [f.story] })).toHaveLength(1);
  });
  it('only captures dates from verified relevant unsuperseded successful primary reads', async () => {
    const f = await fixture();
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { role: 'supporting' });
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { verified: false });
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { relevance: 'irrelevant' });
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { superseded: true });
    await addEvidence(f.story, '2026-11-03T07:00:00.000Z', { status: 503 });
    const { publicationInputBoundary } = await import('./input-evidence.js');
    expect((await publicationInputBoundary(f.story)).primaryEventDates).toHaveLength(1);
    expect(await admission.publicationInputAdmission(f.story, '-100123', settings))
      .toEqual({ allowed: true });
  });
  it('captures unknown dates without using fetched/updated timestamps or rejecting the fresh report', async () => {
    const f = await fixture();
    await addEvidence(f.story, null, { dateMetadata: { fetchedAt: '2026-11-03T07:00:00Z', updatedAt: '2026-11-03T07:00:00Z' } });
    await addEvidence(f.story, null, { dateMetadata: { publishedAt: 'not-a-date' } });
    const { publicationInputBoundary } = await import('./input-evidence.js');
    expect((await publicationInputBoundary(f.story)).primaryEventDates?.filter(date => date.publishedAt === null)).toHaveLength(2);
    expect(await admission.publicationInputAdmission(f.story, '-100123', settings))
      .toEqual({ allowed: true });
  });
  it('includes already-read ancestor primary evidence used by generation', async () => {
    const f = await fixture();
    const ancestor = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
    await database.db.query('UPDATE story_evidence SET story_id=$2 WHERE story_id=$1', [f.story, ancestor]);
    await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
      VALUES($1,$2,'verified-test')`, [f.story, ancestor]);
    expect(await admission.publicationInputAdmission(f.story, '-100123', settings))
      .toEqual({ allowed: true });
  });
  it('accepts a saved v2 boundary without event dates without reconstructing it at dispatch', async () => {
    const f = await fixture(); const pub = await prepareDirect(f.story);
    const key = `publication_input:${pub.id}`;
    await database.db.query("UPDATE operational_state SET value=value-'primaryEventDates' WHERE key=$1", [key]);
    const before = await admission.preparedPublicationInputs(pub.id);
    expect(before?.inputs.length).toBeGreaterThan(0);
    expect(before?.primaryEventDates).toBeUndefined();
    const { publicationAdmission } = await import('./freshness.js');
    expect(await publicationAdmission(database.db, pub, settings, 'send')).toEqual({ allowed: true });
    expect(await admission.preparedPublicationInputs(pub.id)).toEqual(before);
    // A safe unattempted modern refresh can still capture informational dates.
    await database.transaction(client => admission.recordPublicationInputs(client, pub.id, f.story));
    expect((await admission.preparedPublicationInputs(pub.id))?.primaryEventDates).toHaveLength(1);
  });
  it('rechecks the report date against the current window despite an old primary', async () => {
    const f = await fixture(); const pub = await prepareDirect(f.story);
    const { publicationAdmission } = await import('./freshness.js');
    await (await import('../settings.js')).saveSettings({ collectionWindowHours: 20 });
    expect(await publicationAdmission(database.db, pub, settings, 'send')).toEqual({ allowed: true });
    await (await import('../settings.js')).saveSettings({ collectionWindowHours: 19 });
    expect(await publicationAdmission(database.db, pub, settings, 'send'))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('rejects an old report even if a fresh primary is available', async () => {
    const f = await fixture('2026-11-03T07:00:00.000Z');
    await database.db.query("UPDATE source_items SET published_at='2026-10-21T12:00:00Z' WHERE id=$1", [f.item]);
    expect(await admission.publicationInputAdmission(f.story, '-100123', settings))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
    expect(await store.prepareDigest(settings, '-100123', { storyIds: [f.story] })).toEqual([]);
  });
  it('rejects unchanged reprocessing of the fresh recap after publication', async () => {
    const f = await fixture(); const pub = await prepareDirect(f.story);
    await database.db.query(`UPDATE publications SET status='published',message_id='sent-fixture',
      published_at='2026-11-03T07:00:00Z' WHERE id=$1`, [pub.id]);
    await database.db.query("UPDATE operational_state SET value=value-'primaryEventDates' WHERE key=$1", [`publication_input:${pub.id}`]);
    expect(await admission.publicationInputAdmission(f.story, '-100123', settings))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
});
