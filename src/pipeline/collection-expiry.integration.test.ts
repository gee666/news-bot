import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';

const inference = vi.hoisted(() => ({ judge: vi.fn(), generate: vi.fn() }));
vi.mock('../models/jev.js', async original => ({ ...await original<typeof import('../models/jev.js')>(),
  JevClient: class { judge = inference.judge; async close() {} } }));
vi.mock('./generation.js', () => ({ researchStory: inference.generate }));
const url = process.env.TEST_DATABASE_URL;
const schema = `collection_expiry_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
let expiry: typeof import('./item-failures.js');
let storyExpiry: typeof import('./story-expiry.js');
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql, args)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture ID');
  return id;
}
async function batch(manual = false): Promise<string> {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,manual_operation_id)
    VALUES('waiting',now(),$1,$2,$3,$4) RETURNING id`,
  [JSON.stringify(settings), settings.profileVersion, settings.modelVersion, manual ? randomUUID() : null]);
}
async function item(batchId: string, publishedHours: number | null, collectedHours = 0, revisionHours = 0) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Expiry fixture','public') RETURNING id`, [randomUUID()]);
  const id = await one(`INSERT INTO source_items(source_id,external_id,published_at,collected_at)
    VALUES($1,'1',now()-$2*interval '1 hour',now()-$3*interval '1 hour') RETURNING id`, [source, publishedHours, collectedHours]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,created_at)
    VALUES($1,1,$2,'First report. Second report.','First report. Second report.',now()-$3*interval '1 hour') RETURNING id`,
  [id, randomUUID(), revisionHours]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [id, revision]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
  return revision;
}
async function mentions(batchId: string, revision: string, mixed = false) {
  await (await import('./extraction-store.js')).applyExtraction(batchId, revision, 'First report. Second report.',
    mixed ? [{ start: 0, end: 13 }, { start: 14, end: 28 }] : [{ start: 0, end: 13 }]);
  return (await database.db.query<{ id: string }>('SELECT id FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal', [revision])).rows.map(row => row.id);
}
async function stage(batchId: string, revision: string, name: string, status = 'waiting') {
  return one(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at,attempts)
    VALUES($1,$2,$3,$4,now()+interval '7 days',2) RETURNING id`, [batchId, revision, name, status]);
}
async function attached(batchId: string, revision: string) {
  const [mention] = await mentions(batchId, revision);
  const story = await one("INSERT INTO stories(status,chosen_excerpt) VALUES('failed','First report.') RETURNING id");
  await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE id=$1', [mention, story]);
  return story;
}
async function rows(sql: string, args: unknown[] = []) { return (await database.db.query(sql, args)).rows; }

describe.skipIf(!url)('collection-window expiry during model outages', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString()); vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).saveSettings({ collectionWindowHours: 6, embeddingDimensions: 3 });
    expiry = await import('./item-failures.js'); storyExpiry = await import('./story-expiry.js');
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    inference.judge.mockRejectedValue(new Error('Inference must not run for stale drafts'));
    inference.generate.mockRejectedValue(new Error('Generation must not run for stale drafts'));
    await database.db.query('TRUNCATE sources,stories,processing_batches,operational_state CASCADE');
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it.each([false, true])('uses publication age despite recent collection/revision timestamps, extracted=%s', async extracted => {
    const id = await batch(); const revision = await item(id, 7);
    if (extracted) await mentions(id, revision);
    const pending = await stage(id, revision, extracted ? 'links:events-v6' : 'extract:events-v6', 'pending');
    await stage(id, revision, 'count', 'failed');
    const completed = await stage(id, revision, 'item_eligibility:receipt', 'completed');
    const before = await rows('SELECT * FROM item_revisions WHERE id=$1', [revision]);
    await expiry.expireUnassignedMentions(settings); await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status,disposition_reason FROM batch_items WHERE batch_id=$1', [id]))
      .toEqual([{ status: 'rejected', disposition_reason: 'outside_collection_window' }]);
    expect(await rows('SELECT status,next_retry_at,attempts FROM stage_state WHERE id=$1', [pending]))
      .toEqual([{ status: 'skipped', next_retry_at: null, attempts: 2 }]);
    expect(await rows('SELECT status FROM stage_state WHERE id=$1', [completed])).toEqual([{ status: 'completed' }]);
    expect(await rows('SELECT * FROM item_revisions WHERE id=$1', [revision])).toEqual(before);
    await expiry.completeBatchItems(id);
    expect(await rows('SELECT status FROM processing_batches WHERE id=$1', [id])).toEqual([{ status: 'completed' }]);
  });
  it('uses immutable undated retention/collection time, not a new revision or refetch', async () => {
    const id = await batch(); const revision = await item(id, null, 7);
    // Retention is fixed by the insert trigger; a later fetch must not renew it.
    await database.db.query('UPDATE source_items SET collected_at=now() WHERE current_revision_id=$1', [revision]);
    await mentions(id, revision); await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status FROM batch_items WHERE revision_id=$1', [revision])).toEqual([{ status: 'rejected' }]);
  });
  it('keeps fresh dated and undated input even when the batch or revision is older', async () => {
    const id = await batch(); const dated = await item(id, 1, 10, 10); const undated = await item(id, null, 1, 10);
    await database.db.query("UPDATE processing_batches SET cutoff_at=now()-interval '10 hours' WHERE id=$1", [id]);
    await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status FROM batch_items WHERE revision_id=ANY($1::uuid[])', [[dated, undated]]))
      .toEqual([{ status: 'pending' }, { status: 'pending' }]);
  });
  it('preserves active manual pins, then expires only automatic membership when the pin ends', async () => {
    const automatic = await batch(); const manual = await batch(true); const revision = await item(automatic, 7);
    await mentions(automatic, revision);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [manual, revision]);
    const held = await stage(manual, revision, 'links:events-v6', 'pending');
    await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT metadata->>\'disposition\' AS disposition FROM story_mentions')).toEqual([{ disposition: null }]);
    await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1", [manual]);
    await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status FROM batch_items WHERE batch_id=$1', [automatic])).toEqual([{ status: 'rejected' }]);
    expect(await rows('SELECT status FROM batch_items WHERE batch_id=$1', [manual])).toEqual([{ status: 'pending' }]);
    expect(await rows('SELECT status FROM stage_state WHERE id=$1', [held])).toEqual([{ status: 'pending' }]);
  });
  it('does not reject or skip a manually pinned already-expired orphan', async () => {
    const automatic = await batch(); const revision = await item(automatic, 7); await mentions(automatic, revision);
    await expiry.expireUnassignedMentions(settings);
    const manual = await batch(true);
    await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [manual, revision]);
    const held = await stage(manual, revision, 'match:manual:fixture', 'pending');
    await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status FROM batch_items WHERE batch_id=$1', [manual])).toEqual([{ status: 'pending' }]);
    expect(await rows('SELECT status FROM stage_state WHERE id=$1', [held])).toEqual([{ status: 'pending' }]);
  });
  it('retires only orphan comparison waits in a mixed revision and preserves attached story work', async () => {
    const id = await batch(); const revision = await item(id, 7); const [orphan, owned] = await mentions(id, revision, true);
    const story = await one("INSERT INTO stories(chosen_excerpt) VALUES('Second report.') RETURNING id");
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE id=$1', [owned, story]);
    const orphanStage = await stage(id, revision, `match:grouping-v1:${orphan}`, 'pending');
    const embedding = await stage(id, revision, `embed:fixture:${orphan}`);
    const ownedStage = await stage(id, revision, `match:grouping-v1:${owned}`);
    const links = await stage(id, revision, 'links:events-v6');
    await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status,next_retry_at FROM stage_state WHERE id=ANY($1::uuid[])', [[orphanStage, embedding]]))
      .toEqual([{ status: 'skipped', next_retry_at: null }, { status: 'skipped', next_retry_at: null }]);
    expect(await rows('SELECT status FROM stage_state WHERE id=ANY($1::uuid[])', [[ownedStage, links]]))
      .toEqual([{ status: 'waiting' }, { status: 'waiting' }]);
    expect(await rows('SELECT story_id,metadata->>\'disposition\' AS disposition FROM story_mentions WHERE id=$1', [owned]))
      .toEqual([{ story_id: story, disposition: null }]);
    expect(await rows('SELECT status FROM batch_items WHERE batch_id=$1', [id])).toEqual([{ status: 'processing' }]);
  });
  it('preserves committed empty extraction from metadata or a completed stage receipt', async () => {
    const id = await batch(); const metadata = await item(id, 7); const receipt = await item(id, 7);
    await database.db.query(`UPDATE item_revisions SET metadata='{"pipelineExtraction":[]}' WHERE id=$1`, [metadata]);
    const saved = await stage(id, receipt, 'extract:events-v6', 'completed');
    await database.db.query("UPDATE stage_state SET output='[]' WHERE id=$1", [saved]);
    await expiry.expireUnassignedMentions(settings);
    expect(await rows('SELECT status FROM batch_items WHERE batch_id=$1', [id])).toEqual([{ status: 'pending' }, { status: 'pending' }]);
  });
  it.each(['batch', 'digest'])('skips attached stale unpublished stories before %s inference and clears pending story stages', async path => {
    const id = await batch(); const revision = await item(id, 7); const story = await attached(id, revision);
    await database.db.query(`INSERT INTO stage_state(batch_id,story_id,stage,status,next_retry_at)
      VALUES($1,$2,'interest','pending',now()+interval '7 days')`, [id, story]);
    await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2),($3,$4)',
      [`digest_refresh:${story}`, JSON.stringify({ storyId: story }), `pipeline_failed_story:${story}`,
        JSON.stringify({ storyId: story, attempts: 0, errorCode: 'model_outage', next: new Date(0).toISOString() })]);
    const before = await rows('SELECT * FROM stories WHERE id=$1', [story]);
    const { Judgments } = await import('./judgments.js'); const { Vectors } = await import('./vectors.js');
    const { finishBatchStories, refreshDigest } = await import('./stories.js');
    const judgments = new Judgments(settings);
    const vectors = new Vectors(await (await import('../settings.js')).getActiveEmbeddingConfig(), settings);
    try {
      const report = path === 'batch' ? await finishBatchStories(id, settings, judgments, vectors)
        : await refreshDigest(settings, judgments);
      expect(report.skippedStories).toBe(1);
    } finally { await judgments.close(); await vectors.close(); }
    expect(inference.judge).not.toHaveBeenCalled(); expect(inference.generate).not.toHaveBeenCalled();
    expect(await rows('SELECT status,next_retry_at FROM stage_state WHERE story_id=$1', [story]))
      .toEqual([{ status: 'skipped', next_retry_at: null }]);
    expect(await rows('SELECT * FROM stories WHERE id=$1', [story])).toEqual(before);
    expect(await rows('SELECT * FROM operational_state WHERE key=ANY($1::text[])',
      [[`digest_refresh:${story}`, `pipeline_failed_story:${story}`]])).toEqual([]);
  });
  it('keeps attached stories with fresh reports and resumes a stale draft after fresh input arrives', async () => {
    const id = await batch(); const old = await item(id, 7); const story = await attached(id, old);
    expect(await storyExpiry.expireStaleStoryWork(story, settings, null)).toBe(true);
    const fresh = await item(id, 1); const [mention] = await mentions(id, fresh);
    await database.db.query('UPDATE story_mentions SET story_id=$2 WHERE id=$1', [mention, story]);
    expect(await storyExpiry.expireStaleStoryWork(story, settings, null)).toBe(false);
    expect(await rows('SELECT count(*)::int AS n FROM story_mentions WHERE story_id=$1', [story])).toEqual([{ n: 2 }]);
  });
  it('preserves published stories and meaningful fresh revisions in their verified follow-up thread', async () => {
    const id = await batch(); const revision = await item(id, 7); const published = await attached(id, revision);
    const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
      [published, JSON.stringify({ headline: 'Новость', details: 'First report.', score: 7, detailsKind: 'summary', sources: [] })]);
    const publication = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status)
      VALUES($1,$2,'-100123','prepared') RETURNING id`, [published, snapshot]);
    const { recordPublicationInputs } = await import('../publishing/input-admission.js');
    await database.transaction(client => recordPublicationInputs(client, publication, published, { newPreparation: true }));
    await database.db.query("UPDATE publications SET status='published',message_id='1',published_at=now() WHERE id=$1", [publication]);
    expect(await storyExpiry.expireStaleStoryWork(published, settings, null)).toBe(false);
    const draft = await one("INSERT INTO stories(chosen_excerpt) VALUES('First report. Added release details.') RETURNING id");
    await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
      VALUES($1,$2,'fixture-verified')`, [draft, published]);
    const edited = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      SELECT item_id,2,$2,'First report. Added release details.','First report. Added release details.'
      FROM item_revisions WHERE id=$1 RETURNING id`, [revision, randomUUID()]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE current_revision_id=$1', [revision, edited]);
    await database.db.query(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
      VALUES($1,$2,'First report. Added release details.',0)`, [draft, edited]);
    expect(await storyExpiry.expireStaleStoryWork(draft, settings, null)).toBe(false);
    await database.db.query("UPDATE item_revisions SET created_at=now()-interval '7 hours' WHERE id=$1", [edited]);
    expect(await storyExpiry.expireStaleStoryWork(draft, settings, null)).toBe(true);
  });
  it('preserves attached active manual work and bypasses age checks in explicit manual batches', async () => {
    const manual = await batch(true); const revision = await item(manual, 7); const story = await attached(manual, revision);
    expect(await storyExpiry.expireStaleStoryWork(story, settings, null)).toBe(false);
    await database.db.query("UPDATE processing_batches SET status='completed',completed_at=now() WHERE id=$1", [manual]);
    expect(await storyExpiry.expireStaleStoryWork(story, settings, manual)).toBe(false);
    expect(await storyExpiry.expireStaleStoryWork(story, settings, null)).toBe(true);
  });
});
