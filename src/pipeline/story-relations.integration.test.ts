import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { jevTemplates } from '../models/templates.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const schema = `relations_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let relations: typeof import('./story-relations.js');
async function story(): Promise<string> {
  const row = (await database.db.query<{ id: string }>('INSERT INTO stories DEFAULT VALUES RETURNING id')).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function edge(next: string, previous: string, verified = true) {
  await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
    VALUES($1,$2,$3)`, [next, previous, verified ? 'fixture-verified' : null]);
}
async function classify(left: string, right: string, relation: 'same' | 'related' | 'unrelated', origin = 'model') {
  return relations.recordStoryRelations(left, [{ storyId: right, relation,
    ...(relation==='related' && origin==='model' ? { relatedPromptVersion:jevTemplates.duplicate.version } : {})
  }], 'test-v1', { origin });
}
async function ancestors(id: string): Promise<string[]> {
  const { generationThread } = await import('./generation-context.js');
  return (await database.db.query<{ id: string }>(`${generationThread} SELECT id FROM generation_story_ids ORDER BY id`, [id])).rows.map(row => row.id);
}

describe.skipIf(!url)('verified same and related relationship storage', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    relations = await import('./story-relations.js');
  });
  beforeEach(async () => { await database.db.query('TRUNCATE stories CASCADE'); });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('stores canonical undirected pairs, explicit unrelated and provenance without self edges', async () => {
    const [a, b, c] = await Promise.all([story(), story(), story()]);
    await classify(b, a, 'related'); await classify(a, a, 'same'); await classify(a, c, 'unrelated');
    await relations.recordStoryRelations(a, [], 'new-v2', { origin: 'model' });
    await relations.recordStoryRelations(a, [{ storyId: b, relation: 'unrelated' }], 'new-v2', { origin: 'model', scope: 'mention' });
    const rows = (await database.db.query('SELECT * FROM story_relations ORDER BY relation')).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ lower_story_id: [a, b].sort()[0], upper_story_id: [a, b].sort()[1],
      relation: 'related', classifier_version: 'test-v1', provenance: expect.objectContaining({ origin: 'model' }) });
    expect(await relations.relatedStoryIds(a)).toEqual([b]);
    expect(await relations.relatedStoryIds(b)).toEqual([a]);
    await database.db.query('DELETE FROM stories WHERE id=$1', [b]);
    expect(await relations.relatedStoryIds(a)).toEqual([]);
  });
  it('stores only pair fingerprints instead of duplicating the full candidate catalogue', async () => {
    const [a, b, c] = await Promise.all([story(), story(), story()]);
    await relations.recordStoryRelations(a, [{ storyId: b, relation: 'unrelated' }, { storyId: c, relation: 'unrelated' }],
      'test-v1', { origin: 'model', incomingFingerprint: 'incoming', candidates: [
        { storyId: b, fingerprint: 'b' }, { storyId: c, fingerprint: 'c' },
      ] });
    const rows = (await database.db.query<{ provenance: Record<string, unknown> }>('SELECT provenance FROM story_relations')).rows;
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.provenance.candidates)).toEqual(expect.arrayContaining([
      [{ storyId: b, fingerprint: 'b' }], [{ storyId: c, fingerprint: 'c' }],
    ]));
    for (const row of rows) expect(row.provenance).toMatchObject({ origin: 'model', incomingFingerprint: 'incoming' });
  });
  it('compacts legacy catalogue copies without changing decisions or pair evidence', async () => {
    const [a, b, c] = await Promise.all([story(), story(), story()]);
    const provenance = { origin: 'model', incomingFingerprint: 'incoming', quarantined: true,
      relatedPromptVersion: 'test', relatedEvidence: { incomingQuote: 'A', candidateQuote: 'B', connection: 'test' },
      candidates: [{ storyId: b, fingerprint: 'b' }, { storyId: c, fingerprint: 'c' }] };
    await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version,provenance)
      VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'related','legacy',$3)`, [a,b,JSON.stringify(provenance)]);
    const sql = await readFile(new URL('../../migrations/208_pair_relation_provenance.sql', import.meta.url), 'utf8');
    await database.db.query(sql);
    await database.db.query(sql);
    expect((await database.db.query('SELECT relation,classifier_version,provenance FROM story_relations')).rows).toEqual([
      { relation: 'related', classifier_version: 'legacy', provenance: { ...provenance,candidates:[{ storyId: b,fingerprint:'b' }] } },
    ]);
  });
  it('inherits related links both directions through verified same editions only, not related-of-related', async () => {
    const [discovery, recap, shutdown, shutdownEdition, unrelated, legacy] = await Promise.all([story(), story(), story(), story(), story(), story()]);
    await classify(discovery, recap, 'same', 'user');
    await edge(recap, discovery);
    await edge(shutdownEdition, shutdown);
    await edge(legacy, discovery, false);
    await classify(discovery, shutdown, 'related', 'user');
    await classify(shutdown, unrelated, 'related');
    expect((await relations.relatedStoryIds(recap)).sort()).toEqual([shutdown, shutdownEdition].sort());
    expect((await relations.relatedStoryIds(shutdownEdition)).sort()).toEqual([discovery, recap, unrelated].sort());
    expect(await relations.relatedStoryIds(legacy)).toEqual([]);
    expect(await ancestors(recap)).toEqual([discovery, recap].sort());
    expect(await ancestors(legacy)).toEqual([legacy]);
  });
  it('excludes legacy metadata and unverified edges, even if they once produced update headers', async () => {
    const [discovery, shutdown] = await Promise.all([story(), story()]);
    await edge(shutdown, discovery, false);
    expect(await ancestors(shutdown)).toEqual([shutdown]);
    await classify(discovery, shutdown, 'related', 'user');
    expect(await relations.relatedStoryIds(shutdown)).toEqual([discovery]);
    expect(await ancestors(shutdown)).toEqual([shutdown]);
  });
  it('lets an explicit distinct classification override a verified thread even for raw repair rows', async () => {
    const [discovery, shutdown] = await Promise.all([story(), story()]);
    await edge(shutdown, discovery);
    expect(await ancestors(shutdown)).toEqual([discovery, shutdown].sort());
    await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version,provenance)
      VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'related','user-v1','{"origin":"user"}')`, [discovery, shutdown]);
    expect(await ancestors(shutdown)).toEqual([shutdown]);
    expect(await relations.relatedStoryIds(shutdown)).toEqual([discovery]);
  });
  it('quarantines a contradictory transitive component and rejects attempts to stitch it back together', async () => {
    const [a, b, c] = await Promise.all([story(), story(), story()]);
    await classify(a, b, 'same'); await classify(b, c, 'same'); await edge(b, a); await edge(c, b);
    await classify(a, c, 'related', 'user');
    expect(await ancestors(c)).toEqual([c]);
    expect(await relations.relatedStoryIds(a)).toEqual([c]);
    expect((await database.db.query("SELECT count(*)::int AS n FROM story_relations WHERE provenance->>'quarantined'='true'")).rows).toEqual([{ n: 2 }]);
    await classify(a, b, 'same');
    expect(await classify(b, c, 'same')).toEqual([]);
    expect(await relations.relatedStoryIds(b)).toEqual([c]);
  });
  it('withholds legacy model positives without deleting them and admits decisions from the corrected original prompt',async()=>{
    const [a,b]=await Promise.all([story(),story()]);
    await relations.recordStoryRelations(a,[{storyId:b,relation:'related'}],'grouping-v2',{origin:'model'});
    expect(await relations.relatedStoryIds(a)).toEqual([]);
    expect((await database.db.query('SELECT relation FROM story_relations')).rows).toEqual([{relation:'related'}]);
    await classify(a,b,'related');
    expect(await relations.relatedStoryIds(a)).toEqual([b]);
  });
  it('does not let a same edition reintroduce explicit unrelated targets from either side',async()=>{
    const [a,edition,b,bEdition]=await Promise.all([story(),story(),story(),story()]);
    await classify(a,edition,'same'); await classify(b,bEdition,'same');
    await classify(a,b,'unrelated'); await classify(edition,bEdition,'related');
    expect(await relations.relatedStoryIds(a)).toEqual([]);
    expect(await relations.relatedStoryIds(edition)).toEqual([]);
    expect(await relations.relatedStoryIds(b)).toEqual([]);
    expect((await database.db.query("SELECT relation FROM story_relations WHERE relation='related'")).rowCount).toBe(1);
  });
  it('does not overwrite authoritative user decisions or use automated disagreements to break a user same path', async () => {
    const [a, b, c] = await Promise.all([story(), story(), story()]);
    await classify(a, b, 'same', 'user'); await classify(b, c, 'same', 'user');
    expect(await classify(a, c, 'related')).toEqual([]);
    await classify(a, c, 'related', 'user');
    expect(await classify(a, c, 'same')).toEqual([]);
    expect((await database.db.query("SELECT relation,provenance FROM story_relations WHERE relation='related'")).rows)
      .toEqual([{ relation: 'related', provenance: { origin: 'user' } }]);
  });
});
