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
async function same(left: string, right: string) {
  await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version,provenance)
    VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'same','fixture','{"origin":"model"}')`, [left, right]);
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

// Real retainedStories/group fingerprints and transactions, with no inference requests.
describe.skipIf(!url)('source-only links against complete matching groups', () => {
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

  it.each([false, true])('persists source-only associations for an unchanged group, multiple owners: %s', async multiple => {
    const latest = await story('Fable release pricing.', 1);
    if (multiple) {
      const older = await story('Fable release benchmarks.', 2);
      await same(older.id, latest.id);
    }
    const source = await recap();
    model.generate.mockResolvedValue({ value: { associations: [
      { linkId: source.link, targetId: latest.id, classification: 'relevant' },
    ] } });

    await classify(source.revision);

    expect(model.generate).toHaveBeenCalledOnce();
    const prompt = JSON.parse(model.generate.mock.calls[0]?.[1].prompt);
    expect(prompt.targets).toHaveLength(1);
    expect(prompt.targets[0].id).toBe(latest.id);
    expect(prompt.targets[0].reports.map((report: { text: string }) => report.text).sort()).toEqual(
      multiple ? ['Fable release benchmarks.', 'Fable release pricing.'] : ['Fable release pricing.']);
    expect((await database.db.query('SELECT link_id,story_id,classification FROM story_link_sources')).rows)
      .toEqual([{ link_id: source.link, story_id: latest.id, classification: 'relevant' }]);
    expect((await database.db.query('SELECT revision_id,role FROM source_link_processing')).rows)
      .toEqual([{ revision_id: source.revision, role: 'source_only' }]);
  });

  it.each(['report', 'revision', 'membership'] as const)('rejects changed group %s before saving associations', async change => {
    const older = await story('Fable release benchmarks.', 2);
    const latest = await story('Fable release pricing.', 1);
    await same(older.id, latest.id);
    const source = await recap();
    model.generate.mockImplementation(async () => {
      if (change === 'report') {
        await database.db.query("UPDATE story_mentions SET text='Corrected benchmarks.' WHERE id=$1", [older.mention]);
      } else if (change === 'revision') {
        const replacement = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
          VALUES($1,2,$2,'Replacement','Replacement') RETURNING id`, [older.item, randomUUID()]);
        await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [older.item, replacement]);
      } else {
        const branch = await story('Fable release access.', 3);
        await same(older.id, branch.id);
      }
      return { value: { associations: [{ linkId: source.link, targetId: latest.id, classification: 'relevant' }] } };
    });

    await expect(classify(source.revision)).rejects.toThrow('Link target changed');

    expect((await database.db.query('SELECT * FROM story_link_sources')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM source_link_processing')).rows).toEqual([]);
  });
});
