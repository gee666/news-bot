import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { acceptFixtureStories } from './publishing.test-helpers.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `publication_inputs_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let admission: typeof import('./input-admission.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Fixture missing');
  return row.id;
}
async function story() {
  return one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched,interest_stale,profile_version,model_version)
    VALUES('completed','A model release','The model is available.','Model released',8,true,false,$1,$2) RETURNING id`,
  [settings.profileVersion, settings.modelVersion]);
}
async function report(storyId: string, hours = 1, sourceOnly = false) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Reports','public') RETURNING id`, [randomUUID()]);
  const origin = `https://t.me/reports/${source}`;
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'1',$2,now()-$3*interval '1 hour') RETURNING id`, [source, origin, hours]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,'original','Model released','Model released') RETURNING id`, [item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  let mention: string | undefined;
  if (!sourceOnly) mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
    VALUES($1,$2,'Model released',0) RETURNING id`, [storyId, revision]);
  else {
    const link = await one(`INSERT INTO item_links(revision_id,url,anchor_text,start_offset,end_offset)
      VALUES($1,'https://example.org/report','report',0,6) RETURNING id`, [revision]);
    await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [link, storyId]);
  }
  return { item, revision, mention, origin };
}
async function published(storyId: string, origins: string[], modern = true) {
  const content = { headline: 'A model release', details: 'The model is available.', score: 8, detailsKind: 'summary',
    sources: origins.map(origin => ({ url: origin, label: 'Report', primary: false, access: 'public', classification: 'relevant' })) };
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [storyId, JSON.stringify(content)]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status)
    VALUES($1,$2,'-100123','prepared') RETURNING id`, [storyId, snapshot]);
  if (modern) await database.transaction(client => admission.recordPublicationInputs(client, id, storyId, { newPreparation: true }));
  await database.db.query(`UPDATE publications SET status='published',message_id=$2,published_at=now() WHERE id=$1`, [id, randomUUID()]);
  return { id, snapshot };
}
async function fork(prior: string) {
  const draft = await story();
  await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
    VALUES($1,$2,'test-verified')`, [draft, prior]);
  await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE story_id=$1', [prior, draft]);
  return draft;
}
async function revise(item: string, text: string) {
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    SELECT $1,max(revision_number)+1,$2,$3,$3 FROM item_revisions WHERE item_id=$1 RETURNING id`, [item, randomUUID(), text]);
  await database.db.query(`UPDATE story_mentions SET revision_id=$2,text=$3 WHERE revision_id IN(SELECT id FROM item_revisions WHERE item_id=$1)`, [item, revision, text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
}

describe.skipIf(!url)('publication input baselines in PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    admission = await import('./input-admission.js');
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE sources,stories,publications,publication_snapshots,request_attempts CASCADE');
    await database.db.query('DELETE FROM operational_state');
    settings = await (await import('../settings.js')).saveSettings({ publishingEnabled: false, collectionWindowHours: 48 });
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('does not reconstruct a legacy baseline from origin URLs, timestamps or moved mentions', async () => {
    const prior = await story(); const input = await report(prior);
    const sent = await published(prior, [input.origin], false);
    const snapshot = (await database.db.query('SELECT * FROM publication_snapshots WHERE id=$1', [sent.snapshot])).rows;
    expect(await admission.publicationInputAdmission(prior, '-100123', settings))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
    const draft = await fork(prior);
    expect(await admission.publicationInputAdmission(draft, '-100123', settings))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
    await revise(input.item, 'Model released');
    expect(await admission.publicationInputAdmission(draft, '-100123', settings))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
    expect((await database.db.query('SELECT * FROM publication_snapshots WHERE id=$1', [sent.snapshot])).rows).toEqual(snapshot);
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`publication_input:${sent.id}`])).rows).toEqual([]);
  });
  it('allows a proven new text revision of an old published primary', async () => {
    const prior = await story(); const input = await report(prior, 300);
    await published(prior, [input.origin]);
    const draft = await fork(prior);
    await revise(input.item, 'Model released with newly announced training results');
    expect(await admission.publicationInputAdmission(draft, '-100123', settings)).toEqual({ allowed: true });
  });
  it('admits recent source-only coverage, including additions still on a queued ancestor', async () => {
    const prior = await story(); const input = await report(prior);
    await published(prior, [input.origin]);
    const draft = await fork(prior);
    await report(prior, 1, true);
    expect(await admission.publicationInputAdmission(draft, '-100123', settings))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(await admission.publicationInputAdmission(draft, '-100123', settings, undefined, { storyIds: [prior] }))
      .toEqual({ allowed: true });
  });
  it('does not infer historical ownership from extraction time when an old mention is moved in later', async () => {
    const prior = await story(); const original = await report(prior);
    const separate = await story(); const addition = await report(separate);
    await database.db.query("UPDATE story_mentions SET created_at=now()-interval '1 day' WHERE id=$1", [addition.mention]);
    await published(prior, [original.origin]);
    const draft = await fork(prior);
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE id=$1', [addition.mention, draft]);
    expect(await admission.publicationInputAdmission(draft, '-100123', settings)).toEqual({ allowed: true });
  });
  it.each(['classification', 'extraction', 'unrelated_parent_edit'] as const)(
    'does not admit %s changes without genuinely new scoped collected payload', async kind => {
      const id = await story(); const input = await report(id);
      if (!input.mention) throw new Error('Missing mention fixture');
      await database.db.query(`UPDATE item_revisions SET original_text='Alpha released. Beta costs 10.',
        normalized_text='Alpha released. Beta costs 10.' WHERE id=$1`, [input.revision]);
      await database.db.query("UPDATE story_mentions SET text='Alpha released' WHERE id=$1", [input.mention]);
      const link = await one(`INSERT INTO item_links(revision_id,url) VALUES($1,'https://example.org/known') RETURNING id`, [input.revision]);
      await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'irrelevant')`, [input.mention, link]);
      await published(id, [input.origin]);
      if (kind === 'classification') await database.db.query("UPDATE mention_links SET classification='relevant' WHERE mention_id=$1", [input.mention]);
      if (kind === 'extraction') await database.db.query("UPDATE story_mentions SET text='Alpha released. Beta costs 10.' WHERE id=$1", [input.mention]);
      if (kind === 'unrelated_parent_edit') {
        const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
          VALUES($1,2,'unrelated-edit','Alpha released. Beta costs 20.','Alpha released. Beta costs 20.') RETURNING id`, [input.item]);
        await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [input.item, revision]);
        await database.db.query('UPDATE story_mentions SET revision_id=$2 WHERE id=$1', [input.mention, revision]);
      }
      expect(await admission.publicationInputAdmission(id, '-100123', settings))
        .toEqual({ allowed: false, reason: 'no_new_source_input' });
    });
  it('rejects a newly attached old source even if extracted today', async () => {
    const prior = await story(); const original = await report(prior);
    await published(prior, [original.origin]);
    const draft = await fork(prior);
    await report(draft, 300, true);
    expect(await admission.publicationInputAdmission(draft, '-100123', settings))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('fails closed on missing legacy provenance rather than inventing a baseline from current mentions', async () => {
    const prior = await story(); await report(prior);
    await published(prior, [], false);
    expect(await admission.publicationInputAdmission(prior, '-100123', settings))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
  });
  it('rejects a partially modern thread even when new recent coverage exists', async () => {
    const legacy = await story(); const input = await report(legacy);
    await published(legacy, [input.origin], false);
    const modern = await fork(legacy);
    await published(modern, [input.origin]);
    await report(modern, 1, true);
    expect(await admission.publicationInputAdmission(modern, '-100123', settings))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
    expect(await admission.publishedInputBoundary(modern, '-100123')).toMatchObject({ published: true, verifiable: false });
  });
  it('returns no prepared boundary for absent, invalid or v1 legacy state without adopting current reports', async () => {
    const id = await story(); const input = await report(id);
    const legacy = await published(id, [input.origin], false);
    expect(await admission.preparedPublicationInputs(legacy.id)).toBeNull();
    await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
      [`publication_input:${legacy.id}`, JSON.stringify({ version: 'publication-input-v1', inputs: [] })]);
    expect(await admission.preparedPublicationInputs(legacy.id)).toBeNull();
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`publication_input:${legacy.id}`])).rows)
      .toEqual([{ value: { version: 'publication-input-v1', inputs: [] } }]);
  });
  it('uses immutable retention for an undated source refetched today', async () => {
    const id = await story(); const input = await report(id, 300);
    await database.db.query('UPDATE source_items SET published_at=NULL,collected_at=now() WHERE id=$1', [input.item]);
    expect(await admission.publicationInputAdmission(id, '-100123', settings))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('withholds old reports in newly generated stories before any publication is prepared', async () => {
    const id = await story(); await report(id, 300);
    await acceptFixtureStories(settings, [id]);
    const { prepareDigest } = await import('./store.js');
    expect(await prepareDigest(settings, '-100123', { storyIds: [id] })).toEqual([]);
    expect((await database.db.query('SELECT id FROM publications')).rows).toEqual([]);
  });
  it.each(['legacy', 'attempted', 'reserved', 'media'] as const)('does not establish a first baseline for %s prepared work', async kind => {
    const id = await story(); const input = await report(id);
    const queued = await published(id, [input.origin], false);
    await database.db.query(`UPDATE publications SET status='prepared',message_id=NULL,published_at=NULL WHERE id=$1`, [queued.id]);
    if (kind === 'attempted') await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
      VALUES($1,'telegram-bot','send',1,'retryable')`, [queued.id]);
    if (kind === 'reserved') await database.db.query(`INSERT INTO publication_destination_reservations(destination_id,publication_id)
      VALUES('-100123',$1)`, [queued.id]);
    if (kind === 'media') await database.db.query(`INSERT INTO publication_media_batches(publication_id,batch_number) VALUES($1,0)`, [queued.id]);
    await database.transaction(client => admission.recordPublicationInputs(client, queued.id, id,
      kind === 'legacy' ? {} : { newPreparation: true }));
    expect(await admission.preparedPublicationInputs(queued.id)).toBeNull();
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`publication_input:${queued.id}`])).rows).toEqual([]);
  });
  it('captures inputs atomically at preparation and never overwrites an attempted baseline', async () => {
    const id = await story(); const input = await report(id);
    await acceptFixtureStories(settings, [id]);
    const { prepareDigest } = await import('./store.js');
    const [publicationId] = await prepareDigest(settings, '-100123', { storyIds: [id] });
    expect(publicationId).toBeDefined();
    const key = `publication_input:${publicationId}`;
    const before = (await database.db.query('SELECT value FROM operational_state WHERE key=$1', [key])).rows;
    expect(before[0]?.value.inputs.length).toBeGreaterThan(0);
    await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
      VALUES($1,'telegram-bot','send',1,'retryable')`, [publicationId]);
    await revise(input.item, 'Substantially updated report');
    await database.transaction(client => admission.recordPublicationInputs(client, publicationId ?? '', id));
    expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [key])).rows).toEqual(before);
  });
});
