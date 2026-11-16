import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';

const model = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock('../models/index.js', () => ({ generateStructured: model.generate }));
vi.mock('./generation-model.js', () => ({
  generationClient: vi.fn(), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
const schema = `source_links_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let classifyItemLinks: typeof import('./source-links.js').classifyItemLinks;

async function one(sql: string, args: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing source-link fixture');
  return row.id;
}
async function sourceItem(text: string) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Source-link fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'1',$2,now()) RETURNING id`, [source, `https://example.org/${source}`]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  return { item, revision };
}
async function story(text: string, ageHours: number) {
  const id = await one(`INSERT INTO stories(chosen_excerpt,created_at)
    VALUES($1,now()-$2*interval '1 hour') RETURNING id`, [text, ageHours]);
  const source = await sourceItem(text);
  const mention = await one(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal)
    VALUES($1,$2,$3,0) RETURNING id`, [source.revision, id, text]);
  return { id, mention, ...source };
}
async function recap() {
  const source = await sourceItem('Source-only recap of the Fable release.');
  const link = await one(`INSERT INTO item_links(revision_id,url)
    VALUES($1,'https://example.org/fable-announcement') RETURNING id`, [source.revision]);
  return { ...source, link };
}
async function classify(revisionId: string) {
  return classifyItemLinks(revisionId, settings, {
    id: randomUUID(), attempt: 1, batchId: null, revisionId, storyId: null,
  });
}

// Real revision and mention-link writes, with no inference requests.
describe.skipIf(!url)('links for extracted news only', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? '');
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    database = await import('../db.js');
    await database.migrate();
    settings = (await import('../settings.js')).defaultSettings;
    ({ classifyItemLinks } = await import('./source-links.js'));
  });
  beforeEach(async () => {
    model.generate.mockReset();
    await database.db.query('TRUNCATE sources,stories CASCADE');
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('leaves a source-only recap empty even with matching stories in the catalogue', async () => {
    const existing = await story('Fable release pricing.', 1);
    const source = await recap();
    await database.db.query('UPDATE stories SET interest_stale=false WHERE id=$1', [existing.id]);

    await classify(source.revision);
    await story('Fable release benchmarks.', 2);
    await classify(source.revision);

    expect(model.generate).not.toHaveBeenCalled();
    expect((await database.db.query('SELECT * FROM story_link_sources')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM source_link_processing')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM mention_links')).rows).toEqual([]);
    expect((await database.db.query('SELECT interest_stale FROM stories WHERE id=$1', [existing.id])).rows)
      .toEqual([{ interest_stale: false }]);
    expect((await database.db.query("SELECT 1 FROM operational_state WHERE key LIKE 'digest_refresh:%'")).rows).toEqual([]);
  });

  it('uses only its own reports and updates omitted link pairs to irrelevant', async () => {
    const foreign = await story('Fable release benchmarks elsewhere.', 2);
    const own = await story('Fable release pricing.', 1);
    const link = await one(`INSERT INTO item_links(revision_id,url)
      VALUES($1,'https://example.org/fable-announcement') RETURNING id`, [own.revision]);
    const footer = await one(`INSERT INTO item_links(revision_id,url,anchor_text)
      VALUES($1,'https://example.org/channel','Subscribe') RETURNING id`, [own.revision]);
    model.generate.mockResolvedValue({ value: { associations: [
      { linkId: link, targetId: own.mention, classification: 'relevant' },
    ] } });
    await classify(own.revision);

    const prompt = JSON.parse(model.generate.mock.calls[0]?.[1].prompt);
    expect(prompt.targets).toEqual([{ id: own.mention, text: 'Fable release pricing.' }]);
    expect((await database.db.query('SELECT mention_id,link_id,classification FROM mention_links ORDER BY link_id')).rows)
      .toEqual([
        { mention_id: own.mention, link_id: link, classification: 'relevant' },
        { mention_id: own.mention, link_id: footer, classification: 'irrelevant' },
      ].sort((a, b) => a.link_id.localeCompare(b.link_id)));
    expect((await database.db.query('SELECT 1 FROM mention_links WHERE mention_id=$1', [foreign.mention])).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM story_link_sources')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM source_link_processing')).rows).toEqual([]);

    model.generate.mockResolvedValue({ value: { associations: [] } });
    await classify(own.revision);
    expect((await database.db.query('SELECT DISTINCT classification FROM mention_links')).rows)
      .toEqual([{ classification: 'irrelevant' }]);
  });
});
