import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import type { EventInput } from './consolidation-input.js';
import type { StoryRelationDecision } from './story-relations.js';

const model = vi.hoisted(() => ({ group: vi.fn<(incoming: EventInput, candidates: EventInput[]) => Promise<StoryRelationDecision[]>>()
  .mockResolvedValue([]) }));
vi.mock('./grouping-model.js', () => ({ GROUPING_VERSION: 'candidate-test',
  async groupReport(incoming: EventInput, candidates: EventInput[], _settings: AppSettings, _context: unknown,
    options: { stopOnSame: boolean }) {
    const fixture = await model.group(incoming, candidates);
    const classified: StoryRelationDecision[] = [];
    for (const candidate of candidates) {
      const decision = fixture.find(value => value.storyId === candidate.id);
      if (decision) classified.push(decision);
      if (options.stopOnSame && decision?.relation === 'same') break;
    }
    return classified;
  },
}));
vi.mock('../models/embedding.js', () => ({ EmbeddingClient: class {
  async embed() { return { vectors: [[1, 2, 3]] }; }
  async close() {}
} }));
const url = process.env.TEST_DATABASE_URL;
const schema = `matching_candidates_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let config: Awaited<ReturnType<typeof import('../settings.js').getActiveEmbeddingConfig>>;
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing candidate fixture');
  return row.id;
}
async function batch(): Promise<string> {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
}
async function report(text: string, story: string | null, access = 'public', vector = [1, 2, 3], ageDays = 0) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Fixture',$2) RETURNING id`, [randomUUID(), access]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'1',$2,now()-$3*interval '1 day') RETURNING id`, [source, `https://example.org/${source}`, ageDays]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one('INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,$3,0) RETURNING id', [revision, story, text]);
  await database.db.query(`INSERT INTO embeddings(config_id,mention_id,input_hash,embedding)
    VALUES($1,$2,'fixture',$3::vector)`, [config.id, mention, JSON.stringify(vector)]);
  return { source, item, revision, mention };
}
async function story(text: string, age = 0, access = 'public', vector = [1, 2, 3], reportAgeDays = 0) {
  const id = await one(`INSERT INTO stories(chosen_excerpt,summary,created_at)
    VALUES('Display text is not evidence','Generated summary is not evidence',now()-$1*interval '1 hour') RETURNING id`, [age]);
  return { id, ...await report(text, id, access, vector, reportAgeDays) };
}
async function same(older: string, newer: string, thread = true, quarantined = false) {
  await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version,provenance)
    VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'same','fixture',$3)`,
  [older, newer, JSON.stringify({ origin: 'model', ...(quarantined ? { quarantined: true } : {}) })]);
  if (thread) await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
    VALUES($1,$2,'fixture')`, [newer, older]);
}
async function classify(batchId?: string, revisionId?: string, mentionId?: string): Promise<EventInput[]> {
  const { matchBatch } = await import('./matching.js');
  const { Vectors } = await import('./vectors.js');
  const currentBatch = batchId ?? await batch();
  const incoming = revisionId && mentionId ? { revision: revisionId, mention: mentionId } : await report('Incoming C.', null);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [currentBatch, incoming.revision]);
  const vectors = new Vectors(config, settings);
  try { await matchBatch(currentBatch, settings, vectors, [incoming.mention]); }
  finally { await vectors.close(); }
  expect(model.group).toHaveBeenCalledOnce();
  return model.group.mock.calls[0]?.[1] ?? [];
}
async function retainedIds(): Promise<string[]> {
  return (await (await import('./matching.js')).retainedStories(settings)).map(input => input.id).sort();
}
async function sourceAnchor(incoming: Awaited<ReturnType<typeof report>>, ...anchors: Awaited<ReturnType<typeof report>>[]) {
  await database.db.query(`UPDATE source_items SET original_url=(SELECT original_url FROM source_items WHERE id=$1)
    WHERE id=ANY($2::uuid[])`, [incoming.item, anchors.map(anchor => anchor.item)]);
}

describe.skipIf(!url)('canonical matching candidate selection', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    database = await import('../db.js'); await database.migrate();
    const configuration = await import('../settings.js');
    settings = await configuration.saveSettings({ embeddingDimensions: 3 });
    config = await configuration.getActiveEmbeddingConfig();
  });
  beforeEach(async () => {
    model.group.mockReset().mockResolvedValue([]); vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    await database.db.query('TRUNCATE processing_batches,sources,stories,story_merges,model_cache CASCADE');
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('compares C once against combined A and B reports without changing either owner', async () => {
    const a = await story('Initial announcement A.', 3); const b = await story('Latest report B.', 2);
    await report('Second B report with uncertainty.', b.id);
    const link = await one("INSERT INTO item_links(revision_id,url) VALUES($1,'https://example.org/primary') RETURNING id", [b.revision]);
    await database.db.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')", [b.mention, link]);
    await same(a.id, b.id);
    const { eventInput } = await import('./consolidation-input.js');
    const originalA = await eventInput(a.id); const originalB = await eventInput(b.id);
    expect(await retainedIds()).toEqual([b.id]);
    const { groupEventInput } = await import('./matching-group-input.js');
    const group = await groupEventInput(b.id, settings);
    expect(await classify()).toEqual([group]);
    expect(group?.reports).toEqual([...(originalA?.reports ?? []), ...(originalB?.reports ?? [])]);
    expect(group?.reports).toHaveLength(3);
    expect(group?.text).not.toContain('Generated summary');
    expect(originalB?.reports).toHaveLength(2);
    expect(originalB?.reports[0]).toMatchObject({ text: 'Latest report B.', links: ['https://example.org/primary'],
      sourceUrl: `https://example.org/${b.source}`, publishedAt: expect.any(String) });
    expect(await eventInput(a.id)).toEqual(originalA); expect(await eventInput(b.id)).toEqual(originalB);
    const { loadStory } = await import('./generation-store.js');
    expect((await loadStory(b.id)).mentions.map(mention => mention.text).sort()).toEqual([
      'Initial announcement A.', 'Latest report B.', 'Second B report with uncertainty.',
    ].sort());
  });
  it('maps all historical IDs to the newest live member through verified same relations without requiring a thread', async () => {
    const a = await story('A.', 4); const b = await story('B.', 3); const c = await story('Current.', 2);
    const { currentStoryRepresentatives } = await import('./matching-representatives.js');
    expect(await currentStoryRepresentatives([a.id], settings)).toEqual(new Map([[a.id, a.id]]));
    await same(a.id, b.id, false); await same(b.id, c.id, false);
    expect(await currentStoryRepresentatives([a.id, b.id, c.id], settings)).toEqual(new Map([[a.id, c.id], [b.id, c.id], [c.id, c.id]]));
    expect(await retainedIds()).toEqual([c.id]); expect((await classify()).map(input => input.id)).toEqual([c.id]);
  });
  it('uses the supplied transaction client to see newly verified identity without a separate connection', async () => {
    const a = await story('A.', 3); const b = await story('B.', 2);
    const { currentStoryRepresentatives } = await import('./matching-representatives.js');
    await database.transaction(async client => {
      await client.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version)
        VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'same','fixture')`, [a.id, b.id]);
      expect(await currentStoryRepresentatives([a.id], settings, client)).toEqual(new Map([[a.id, b.id]]));
    });
  });
  it('does not resurrect quarantined relations, blocked threads or unclassified ancestry', async () => {
    const a = await story('A.', 3); const b = await story('B.', 2); const legacy = await story('Legacy.', 1);
    await same(a.id, b.id, true, true);
    await database.db.query('INSERT INTO story_publication_threads(story_id,previous_story_id) VALUES($1,$2)', [legacy.id, b.id]);
    const before = (await database.db.query('SELECT * FROM story_relations')).rows;
    expect(await retainedIds()).toEqual([a.id, b.id, legacy.id].sort());
    expect((await classify()).map(input => input.id).sort()).toEqual([a.id, b.id, legacy.id].sort());
    expect((await database.db.query('SELECT * FROM story_relations')).rows).toEqual(before);
  });
  it('keeps established same identity despite an older model negative within the component', async () => {
    const a = await story('A.', 3); const b = await story('B.', 2); const c = await story('C.', 1);
    await same(a.id, b.id); await same(b.id, c.id);
    await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version)
      VALUES(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid),'unrelated','fixture')`, [a.id, c.id]);
    expect(await retainedIds()).toEqual([c.id]);
    const candidates = await classify();
    expect(candidates.map(input => input.id)).toEqual([c.id]);
    expect(candidates[0]?.reports.map(report => report.text)).toEqual(['A.', 'B.', 'C.']);
  });
  it('excludes a merged predecessor even when it incorrectly still owns current reports', async () => {
    const canonical = await story('Canonical.', 3); const merged = await story('Merged audit report.', 1);
    await same(canonical.id, merged.id, false);
    await database.db.query("INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')", [merged.id, canonical.id]);
    expect(await retainedIds()).toEqual([canonical.id]);
    expect((await classify()).map(input => input.id)).toEqual([canonical.id]);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE id=$1', [merged.mention])).rows).toEqual([{ story_id: merged.id }]);
  });
  it('filters the newest private representative without falling back to its public predecessor', async () => {
    const a = await story('Public A.', 3); const b = await story('Private B.', 2, 'restricted');
    await same(a.id, b.id);
    const { currentStoryRepresentatives } = await import('./matching-representatives.js');
    expect(await currentStoryRepresentatives([a.id], settings)).toEqual(new Map());
    expect(await retainedIds()).toEqual([]);
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'true');
    expect(await retainedIds()).toEqual([b.id]);
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    expect(await classify()).toEqual([]);
  });
  it('retains an independent prior-revision anchor under its original owner and provenance', async () => {
    const old = await story('Original prior-revision evidence.', 2); const currentBatch = await batch();
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,$2,'Edited C.','Edited C.') RETURNING id`, [old.item, randomUUID()]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [old.item, revision]);
    const mention = await one("INSERT INTO story_mentions(revision_id,text,ordinal) VALUES($1,'Edited C.',0) RETURNING id", [revision]);
    const candidates = await classify(currentBatch, revision, mention);
    expect(candidates).toHaveLength(1); expect(candidates[0]).toMatchObject({ id: old.id,
      reports: [{ text: 'Original prior-revision evidence.', sourceUrl: `https://example.org/${old.source}`, links: [], publishedAt: expect.any(String) }] });
  });
  it('transfers a superseded historical ranking anchor to B without relabelling A evidence as B', async () => {
    const a = await story('Old A anchor.', 3); const b = await story('B owns current evidence.', 2, 'public', [-1, -2, -3]);
    await same(a.id, b.id);
    for (let i = 0; i < 21; i++) await story(`Ordinary ${i}.`, 1);
    const currentBatch = await batch();
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,$2,'Edited C.','Edited C.') RETURNING id`, [a.item, randomUUID()]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [a.item, revision]);
    const mention = await one("INSERT INTO story_mentions(revision_id,text,ordinal) VALUES($1,'Edited C.',0) RETURNING id", [revision]);
    const candidates = await classify(currentBatch, revision, mention);
    expect(candidates.map(input => input.id)).toContain(b.id); expect(candidates.map(input => input.id)).not.toContain(a.id);
    expect(candidates.find(input => input.id === b.id)?.reports.map(report => report.text)).toEqual(['B owns current evidence.']);
  });
  it('combines every publication branch once and excludes the incoming entire component', async () => {
    const a = await story('Root source report.', 4); const b = await story('Left branch report.', 3);
    const c = await story('Right branch report.', 2); const independent = await story('Separate event.', 1);
    await same(a.id, b.id); await same(a.id, c.id);
    const { retainedStories } = await import('./matching.js');
    const { groupEventInput } = await import('./matching-group-input.js');
    const group = await groupEventInput(c.id, settings);
    expect(group?.storyIds.sort()).toEqual([a.id, b.id, c.id].sort());
    expect(group?.reports.map(report => report.text)).toEqual(['Root source report.', 'Left branch report.', 'Right branch report.']);
    expect((await retainedStories(settings, a.id)).map(input => input.id)).toEqual([independent.id]);
    const candidates = await classify();
    expect(candidates).toHaveLength(2); expect(candidates.find(input => input.id === c.id)).toEqual(group);
  });
  it('does not expose a private ancestor through a newer public representative', async () => {
    const a = await story('Secret ancestor.', 3, 'restricted'); const b = await story('Public latest.', 2);
    await same(a.id, b.id);
    const { currentStoryRepresentatives } = await import('./matching-representatives.js');
    expect(await currentStoryRepresentatives([a.id, b.id], settings)).toEqual(new Map());
    expect(await retainedIds()).toEqual([]);
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'true');
    const retained = await (await import('./matching.js')).retainedStories(settings);
    expect(retained).toHaveLength(1);
    expect(retained[0]?.reports.map(report => report.text)).toEqual(['Secret ancestor.', 'Public latest.']);
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    expect(await classify()).toEqual([]);
  });
  it('fingerprints every retained member report and membership, excluding expired and superseded reports', async () => {
    const a = await story('A current.', 4); const b = await story('B current.', 3);
    const expired = await story('Expired report.', 2, 'public', [1, 2, 3], settings.retentionDays + 1);
    await same(a.id, b.id); await same(b.id, expired.id);
    const { groupEventInput, currentMatchingInput } = await import('./matching-group-input.js');
    const original = await groupEventInput(b.id, settings);
    expect(original?.reports.map(report => report.text)).toEqual(['A current.', 'B current.']);
    if (!original) throw new Error('Missing aggregate');
    await database.db.query("UPDATE story_mentions SET text='A changed.' WHERE id=$1", [a.mention]);
    expect((await currentMatchingInput(original))?.fingerprint).not.toBe(original.fingerprint);
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,$2,'Replacement','Replacement') RETURNING id`, [a.item, randomUUID()]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [a.item, revision]);
    expect((await groupEventInput(b.id, settings))?.reports.map(report => report.text)).toEqual(['B current.']);
    const beforeMembership = await groupEventInput(b.id, settings);
    const auditOnly = await one('INSERT INTO stories DEFAULT VALUES RETURNING id');
    await same(b.id, auditOnly, false);
    const afterMembership = await groupEventInput(b.id, settings);
    expect(afterMembership?.reports).toEqual(beforeMembership?.reports);
    expect(afterMembership?.fingerprint).not.toBe(beforeMembership?.fingerprint);
  });
  it('skips weak ordinary pairs outside the nearest three without meaningful lexical overlap', async () => {
    const closest = await story('Paraphrase.', 0, 'public', [1, 2, 3]);
    const second = await story('Alternative.', 0, 'public', [1, 1, 0]);
    const fallback = await story('Translation.', 0, 'public', [2, -1, 0]);
    const weak = await story('Unconnected.', 0, 'public', [-1, -2, -3]);
    const lexical = await story('Incoming hardware update.', 0, 'public', [-1, -2, -3]);
    const genericOverlap = await story('About these offers.', 0, 'public', [-1, -2, -3]);
    const oneLexeme = await story('Hardware discussion.', 0, 'public', [-1, -2, -3]);
    const unknown = await story('Unembedded.');
    await database.db.query('DELETE FROM embeddings WHERE mention_id=$1', [unknown.mention]);
    const source = await story('Syndication.', 0, 'public', [-1, -2, -3]);
    const incoming = await report('Incoming hardware report about these changes.', null);
    await sourceAnchor(incoming, source);
    const ids = (await classify(await batch(), incoming.revision, incoming.mention)).map(input => input.id);
    expect(ids).toEqual([source.id, closest.id, second.id, fallback.id, lexical.id, unknown.id]);
    for (const skipped of [weak, genericOverlap, oneLexeme]) expect(ids).not.toContain(skipped.id);
  });
  it('attaches to the strongest ordinary same match without recording skipped verdicts', async () => {
    const strongest = await story('Closest.', 0, 'public', [1, 2, 3]);
    const weaker = await story('Another draft.', 0, 'public', [1, 1, 0]);
    model.group.mockImplementation(async (_incoming, candidates) => candidates.map(candidate => ({ storyId: candidate.id, relation: 'same' })));
    expect((await classify()).map(input => input.id)).toEqual([strongest.id, weaker.id]);
    expect((await database.db.query("SELECT story_id FROM story_mentions WHERE text='Incoming C.'")).rows).toEqual([{ story_id: strongest.id }]);
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM story_relations')).rows).toEqual([]);
  });
  it('checks a weak source anchor first and stops on its same verdict before other candidates', async () => {
    const anchor = await story('Source anchor.', 3, 'public', [-1, -2, -3]);
    const ordinary = await story('Nearest draft.', 2);
    const incoming = await report('Incoming C.', null);
    await sourceAnchor(incoming, anchor);
    model.group.mockImplementation(async (_incoming, candidates) => candidates.map(candidate => ({ storyId: candidate.id, relation: 'same' })));
    expect((await classify(await batch(), incoming.revision, incoming.mention)).map(input => input.id)).toEqual([anchor.id, ordinary.id]);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE id=$1', [incoming.mention])).rows).toEqual([{ story_id: anchor.id }]);
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM story_relations')).rows).toEqual([]);
  });
  it('rejects a changed non-representative report before attaching to its group', async () => {
    const a = await story('Ancestor report.', 4); const b = await story('Representative report.', 3);
    await same(a.id, b.id); await story('Other matching draft.', 2, 'public', [1, 1, 0]);
    model.group.mockImplementation(async (_incoming, candidates) => {
      await database.db.query("UPDATE story_mentions SET text='Changed while matching.' WHERE id=$1", [a.mention]);
      return candidates.map(candidate => ({ storyId: candidate.id, relation: 'same' }));
    });
    await classify();
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]);
    expect((await database.db.query("SELECT story_id FROM story_mentions WHERE text='Incoming C.'")).rows).toEqual([{ story_id: null }]);
  });
  it('links to the strongest published match without bridging another same anchor or changing either owner', async () => {
    const a = await story('Published A.', 3); const b = await story('Published B.', 2, 'public', [1, 1, 0]);
    for (const id of [a.id, b.id]) {
      const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content)
        VALUES($1,'{"headline":"Published","score":7,"details":"Original","detailsKind":"excerpt","sources":[]}') RETURNING id`, [id]);
      await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,callback_id,status,published_at)
        VALUES($1,$2,'fixture',$3,$4,'published',now())`, [id, snapshot, randomUUID(), randomUUID()]);
    }
    const before = (await database.db.query('SELECT * FROM stories ORDER BY id')).rows;
    const incoming = await report('Incoming C.', null);
    await sourceAnchor(incoming, a, b);
    model.group.mockImplementation(async (_incoming, candidates) => candidates.map(candidate => ({ storyId: candidate.id, relation: 'same' })));
    await classify(await batch(), incoming.revision, incoming.mention);
    expect((await database.db.query('SELECT * FROM stories WHERE id=ANY($1::uuid[]) ORDER BY id', [[a.id, b.id]])).rows).toEqual(before);
    expect((await database.db.query('SELECT * FROM story_merges')).rows).toEqual([]);
    expect((await database.db.query("SELECT relation FROM story_relations WHERE relation='same'")).rows).toHaveLength(1);
    expect(await retainedIds()).toHaveLength(2);
    const { groupEventInput } = await import('./matching-group-input.js');
    expect((await groupEventInput(a.id, settings))?.reports.map(report => report.text).sort())
      .toEqual(['Published A.', 'Incoming C.'].sort());
  });
});
