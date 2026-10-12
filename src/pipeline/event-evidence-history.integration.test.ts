import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
const url = process.env.TEST_DATABASE_URL;
const schema = `event_history_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, args: unknown[] = []) {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing fixture id');
  return row.id;
}
async function fixture() {
  const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Fixture','public') RETURNING id", [randomUUID()]);
  const item = await one('INSERT INTO source_items(source_id,external_id) VALUES($1,$2) RETURNING id', [source, randomUUID()]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'New release.','New release.') RETURNING id`, [item, randomUUID()]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const story = await one("INSERT INTO stories(status,chosen_excerpt,meaningful_hash) VALUES('processing','Old excerpt.','old-input') RETURNING id");
  await database.db.query("INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,'New release.',0)", [revision, story]);
  const evidence = await one(`INSERT INTO evidence_documents(url,title,access,expires_at)
    VALUES('https://example.org/failed-read','Failed read','unavailable',now()+interval '1 day') RETURNING id`);
  await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,assessment)
    VALUES($1,$2,'candidate','uncertain','Diagnostic read failure')`, [story, evidence]);
  return { story, revision, evidence, item };
}
async function retained(story: string, evidence: string) {
  const rows = (await database.db.query('SELECT evidence_id,role,relevance,assessment,superseded_at FROM story_evidence WHERE story_id=$1', [story])).rows;
  expect(rows).toEqual([{ evidence_id: evidence, role: 'candidate', relevance: 'uncertain', assessment: 'Diagnostic read failure', superseded_at: expect.any(Date) }]);
  expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [story])).rows).toEqual([]);
  expect((await database.db.query('SELECT id FROM evidence_documents WHERE id=$1', [evidence])).rows).toEqual([{ id: evidence }]);
}
describe.skipIf(!url)('event invalidation preserves diagnostic story provenance', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? '');
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js');
    await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('supersedes diagnostics when an edited event or an empty event is reconciled', async () => {
    const { reconcileStory } = await import('./revisions.js');
    for (const empty of [false, true]) {
      const { story, evidence, item } = await fixture();
      if (empty) await database.db.query('UPDATE source_items SET current_revision_id=NULL WHERE id=$1', [item]);
      await database.transaction(client => reconcileStory(client, story));
      await retained(story, evidence);
      const stamp = (await database.db.query('SELECT superseded_at FROM story_evidence WHERE story_id=$1', [story])).rows[0]?.superseded_at;
      await database.transaction(client => reconcileStory(client, story));
      expect((await database.db.query('SELECT superseded_at FROM story_evidence WHERE story_id=$1', [story])).rows[0]?.superseded_at).toEqual(stamp);
    }
  });
  it('keeps diagnostics on representative replacement', async () => {
    const { story, evidence } = await fixture();
    const { selectRepresentative } = await import('./stories.js');
    await selectRepresentative(story, { judge: async () => { throw new Error('Single report needs no judgment'); } },
      { id: story, storyId: story, batchId: null, revisionId: null, attempt: 1 });
    await retained(story, evidence);
  });
  it('keeps diagnostics after eligibility rejection', async () => {
    const { story, evidence } = await fixture();
    const { assessEligibility } = await import('./eligibility.js');
    await assessEligibility(story, settings, { judge: async () => ({ type: 'choice', choice: 'rejected', probabilities: {}, confidence: 1 }) },
      { id: story, storyId: story, batchId: null, revisionId: null, attempt: 1 });
    await retained(story, evidence);
  });
});
