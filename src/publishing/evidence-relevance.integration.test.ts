import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoryContent } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `source_relevance_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let snapshotFor: typeof import('./store.js').snapshotFor;
let expectedSourceUrls: typeof import('./preview-sources.js').expectedSourceUrls;
let sourceId: string;
const sharedUrl = 'https://publisher.org/unrelated';

async function one(sql: string, args: unknown[] = []): Promise<string> {
  const result = await database.db.query<{ id: string }>(sql, args);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Missing fixture id');
  return id;
}
async function story(): Promise<StoryContent> {
  const id = await one("INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched) VALUES('completed','News','Details','Event',6,false) RETURNING id");
  return { id, headline: 'News', summary: 'Details', chosen_excerpt: 'Event', translated_excerpt: 'Fixture details',
    interest_score: 6, researched: false };
}
async function link(storyId: string, target = sharedUrl) {
  const item = await one('INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,$2,$3) RETURNING id',
    [sourceId, randomUUID(), `https://t.me/channel/${randomUUID()}`]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Event','Event') RETURNING id`, [item, randomUUID()]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one('INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,\'Event\',0) RETURNING id', [revision, storyId]);
  const id = await one('INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id', [revision, target]);
  await database.db.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')", [mention, id]);
  return id;
}
async function evidence(storyId: string, relevance: 'relevant' | 'irrelevant' | 'uncertain', target = sharedUrl,
  content: string | null = 'Readable document') {
  const id = await one(`INSERT INTO evidence_documents(url,canonical_url,content,access,expires_at,metadata)
    VALUES($1,$1,$2,$3,now()+interval '1 day','{"researchInputHash":"old"}') RETURNING id`,
  [target, content, content ? 'public' : 'restricted']);
  await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,assessment,assessed_at,verified_at)
    VALUES($1,$2,CASE WHEN $3='relevant' THEN 'supporting' ELSE 'candidate' END,$3,$4,$5,
      CASE WHEN $3='relevant' THEN now() ELSE NULL END)`, [storyId, id, relevance,
    relevance === 'uncertain' ? null : 'Typed per-story assessment', relevance === 'uncertain' ? null : new Date()]);
  return id;
}

const urls = async (value: StoryContent) => (await snapshotFor(database.db, value)).sources.map(source => source.url);
describe.skipIf(!url)('typed fetched-source relevance', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? '');
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js');
    await database.migrate();
    ({ snapshotFor } = await import('./store.js'));
    ({ expectedSourceUrls } = await import('./preview-sources.js'));
    sourceId = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram','relevance','Channel','public') RETURNING id");
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('preserves blocked/empty diagnostics as uncertain without presenting them as sources', async () => {
    const current = await story();
    await link(current.id);
    await evidence(current.id, 'uncertain', sharedUrl, null);
    expect(await urls(current)).not.toContain(sharedUrl);
    expect(await expectedSourceUrls(database.db, current.id, current)).not.toContain(sharedUrl);
    expect((await database.db.query('SELECT relevance FROM story_evidence WHERE story_id=$1', [current.id])).rows).toEqual([{ relevance: 'uncertain' }]);
  });

  it('current unrelated assessment overrides current links, archived primary evidence and historical relevant snapshots', async () => {
    const current = await story();
    const loser = await story();
    await link(current.id);
    const document = await evidence(current.id, 'irrelevant');
    await database.db.query(`INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')`, [loser.id, current.id]);
    const old = await one(`INSERT INTO evidence_documents(url,access,expires_at) VALUES($1,'public',now()+interval '1 day') RETURNING id`, [sharedUrl]);
    await database.db.query(`INSERT INTO story_merge_evidence(merged_story_id,canonical_story_id,evidence_id,role,relevance,assessment,assessed_at)
      VALUES($1,$2,$3,'primary','relevant','Old assessment',now())`, [loser.id, current.id, old]);
    const snap = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [loser.id,
      JSON.stringify({ headline: 'Old', score: 6, details: 'Old details', detailsKind: 'summary', sources: [
        { label: 'Old primary', url: sharedUrl, access: 'public', classification: 'relevant', primary: true },
      ] })]);
    await database.db.query("INSERT INTO publications(story_id,snapshot_id,destination_id) VALUES($1,$2,'test')", [loser.id, snap]);
    expect(await urls(current)).not.toContain(sharedUrl);
    expect(await expectedSourceUrls(database.db, current.id, current)).not.toContain(sharedUrl);
    expect((await database.db.query('SELECT classification FROM mention_links ml JOIN item_links l ON l.id=ml.link_id WHERE l.url=$1', [sharedUrl])).rows)
      .toEqual(expect.arrayContaining([{ classification: 'relevant' }]));
    const { resetResearchFixture } = await import('../pipeline/generation.test-helpers.js');
    await resetResearchFixture(current.id);
    expect(await urls(current)).not.toContain(sharedUrl);
    expect(await expectedSourceUrls(database.db, current.id, current)).not.toContain(sharedUrl);
    const other = await story();
    await link(other.id);
    await evidence(other.id, 'relevant');
    expect(await urls(other)).toContain(sharedUrl);
    // Reassessment is reversible; an archived negative is not a permanent block.
    await database.db.query(`UPDATE story_evidence SET relevance='relevant',role='supporting',verified_at=now(),assessed_at=now(),assessment='Relevant now'
      WHERE story_id=$1 AND evidence_id=$2`, [current.id, document]);
    expect(await urls(current)).toContain(sharedUrl);
    expect(await expectedSourceUrls(database.db, current.id, current)).toContain(sharedUrl);
  });

  it('keeps archived irrelevance through an actual merge and cache invalidation until a new relevant assessment', async () => {
    const current = await story();
    const loser = await story();
    await database.db.query("UPDATE stories SET created_at=now()-interval '1 day' WHERE id=$1", [current.id]);
    await link(current.id, 'https://publisher.org/valid');
    await link(loser.id);
    const document = await evidence(loser.id, 'irrelevant');
    // A legacy candidate reason is not a current typed assessment and cannot resurrect the URL.
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,assessment)
      VALUES($1,$2,'candidate','uncertain','Legacy ambiguous reason')`, [current.id, document]);
    const { eventInput } = await import('../pipeline/consolidation-input.js');
    const { mergeStories } = await import('../pipeline/consolidation-store.js');
    const left = await eventInput(current.id);
    const right = await eventInput(loser.id);
    if (!left || !right) throw new Error('Missing merge inputs');
    expect(await mergeStories(left, right, 'same')).toMatchObject({ canonicalId: current.id, mergedId: loser.id });
    expect((await database.db.query('SELECT relevance FROM story_merge_evidence WHERE evidence_id=$1 AND merged_story_id=$2', [document, loser.id])).rows)
      .toEqual([{ relevance: 'irrelevant' }]);
    expect(await urls(current)).not.toContain(sharedUrl);
    expect(await expectedSourceUrls(database.db, current.id, current)).not.toContain(sharedUrl);
    await database.db.query("UPDATE evidence_documents SET expires_at=now()-interval '1 second' WHERE id=$1", [document]);
    const { loadEvidence } = await import('../pipeline/generation-store.js');
    expect(await loadEvidence(current.id, 'new-hash')).toEqual([]);
    expect(await urls(current)).not.toContain(sharedUrl);
    // Simulate deliberate refetch/reassessment under the merged story, preserving the old audit row.
    await evidence(current.id, 'relevant');
    expect(await urls(current)).toContain(sharedUrl);
  });

  it('preserves actual pre-090 PostgreSQL snapshot bytes for backfilled defaults', async () => {
    const { evidenceSnapshotHash } = await import('../pipeline/generation-store.js');
    for (const role of ['primary', 'supporting', 'candidate']) {
      const current = await story();
      const document = await evidence(current.id, role === 'candidate' ? 'uncertain' : 'relevant');
      await database.db.query('UPDATE story_evidence SET role=$3 WHERE story_id=$1 AND evidence_id=$2', [current.id, document, role]);
      const legacy = await database.db.query(`SELECT e.id,e.url,e.canonical_url,e.title,e.content,e.access,e.metadata,
        se.role,se.assessment,e.expires_at>now() AS unexpired FROM story_evidence se
        JOIN evidence_documents e ON e.id=se.evidence_id WHERE se.story_id=$1 ORDER BY e.id`, [current.id]);
      const oldSignature = createHash('sha256').update(JSON.stringify(legacy.rows)).digest('hex');
      expect(await evidenceSnapshotHash(current.id)).toBe(oldSignature);
      // Merely recording a newer assessment time does not change the model's evidence.
      await database.db.query('UPDATE story_evidence SET assessed_at=now() WHERE story_id=$1', [current.id]);
      expect(await evidenceSnapshotHash(current.id)).toBe(oldSignature);
      await database.db.query("UPDATE story_evidence SET relevance='irrelevant' WHERE story_id=$1", [current.id]);
      expect(await evidenceSnapshotHash(current.id)).not.toBe(oldSignature);
    }
  });

  it('migration backfills legacy roles safely without interpreting unrelated reasons', async () => {
    const current = await story();
    const docs = [];
    for (const role of ['primary', 'supporting', 'candidate']) {
      const id = await evidence(current.id, 'uncertain', `https://publisher.org/legacy/${role}`);
      await database.db.query("UPDATE story_evidence SET role=$3,assessment='Unrelated text in legacy reason' WHERE story_id=$1 AND evidence_id=$2", [current.id, id, role]);
      await database.db.query(`INSERT INTO story_merge_evidence(merged_story_id,canonical_story_id,evidence_id,role,assessment)
        VALUES($1,$1,$2,$3,'Unrelated legacy reason')`, [current.id, id, role]);
      docs.push(id);
    }
    // Recreate the pre-090 columns inside this disposable schema, then execute the actual migration.
    await database.db.query('ALTER TABLE story_evidence DROP COLUMN relevance, DROP COLUMN assessed_at');
    await database.db.query('ALTER TABLE story_merge_evidence DROP COLUMN relevance, DROP COLUMN assessed_at');
    await database.db.query(await readFile(new URL('../../migrations/090_evidence_relevance.sql', import.meta.url), 'utf8'));
    for (const table of ['story_evidence', 'story_merge_evidence']) {
      expect((await database.db.query(`SELECT role,relevance FROM ${table} WHERE evidence_id=ANY($1::uuid[]) ORDER BY role`, [docs])).rows)
        .toEqual([{ role: 'candidate', relevance: 'uncertain' }, { role: 'primary', relevance: 'relevant' }, { role: 'supporting', relevance: 'relevant' }]);
    }
  });
});
