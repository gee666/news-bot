import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import { withProcessingSlice } from './processing-slice.js';

const mocks = vi.hoisted(() => ({ empty: vi.fn(), clock: 0 }));
vi.mock('./generation-model.js', () => ({ generationClient: async () => ({}), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
vi.mock('./extraction-model.js', () => ({ extractEvents: mocks.empty }));
const url = process.env.TEST_DATABASE_URL;
const schema = `extraction_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
  if (!row) throw new Error('Missing fixture'); return row.id;
}
async function batch(): Promise<string> {
  return one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version)
    VALUES('processing',now(),$1,$2,$3) RETURNING id`, [JSON.stringify(settings), settings.profileVersion, settings.modelVersion]);
}
async function item(batchId: string, text: string): Promise<string> {
  const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test','public') RETURNING id", [randomUUID()]);
  const itemId = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'1') RETURNING id", [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [itemId, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [itemId, revision]);
  await database.db.query('INSERT INTO batch_items(batch_id,revision_id) VALUES($1,$2)', [batchId, revision]);
  return revision;
}
describe.skipIf(!url)('extraction scheduling and recovery callbacks', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
  });
  beforeEach(async () => {
    mocks.clock = 0; mocks.empty.mockReset().mockImplementation(async (text: string) => [{ parts: [{ start: 0, end: text.length }], context: [] }]);
    await database.db.query('TRUNCATE sources,stories,processing_batches CASCADE');
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.restoreAllMocks(); vi.unstubAllEnvs();
  });
  it('extracts unfinished intake before replaying completed revision callbacks', async () => {
    const batchId = await batch(); const savedText = 'Saved release.';
    const saved = await item(batchId, savedText);
    await (await import('./extraction-store.js')).applyExtraction(batchId, saved, savedText, [{ start: 0, end: savedText.length }]);
    await database.db.query("UPDATE batch_items SET status='completed' WHERE batch_id=$1 AND revision_id=$2", [batchId, saved]);
    const fresh = await item(batchId, 'Fresh release.');
    vi.stubEnv('PROCESSING_SLICE_MS', '1000');
    const now = vi.spyOn(performance, 'now').mockImplementation(() => mocks.clock);
    const callbacks: string[] = [];
    try {
      await withProcessingSlice(() => import('./extraction.js').then(({ extractBatch }) => extractBatch(batchId, settings, async revision => {
        callbacks.push(revision);
        if (revision === saved) mocks.clock = 1001;
      })));
      expect(mocks.empty).toHaveBeenCalledExactlyOnceWith('Fresh release.', expect.anything(), expect.anything(), expect.anything(), settings.interestProfile);
      expect(callbacks).toEqual([fresh, saved]);
      expect((await database.db.query("SELECT metadata ? 'pipelineExtraction' AS extracted FROM item_revisions WHERE id=$1", [fresh])).rows)
        .toEqual([{ extracted: true }]);
    } finally { now.mockRestore(); vi.stubEnv('PROCESSING_SLICE_MS', '120000'); }
  });
  it('still calls recovery callbacks for committed extraction while links cool down', async () => {
    const batchId = await batch(); const text = 'Committed release.';
    const revision = await item(batchId, text);
    const { applyExtraction, EXTRACTION_VERSION } = await import('./extraction-store.js');
    await applyExtraction(batchId, revision, text, [{ start: 0, end: text.length }]);
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
      VALUES($1,$2,$3,'waiting',now()+interval '1 hour')`, [batchId, revision, `links:${EXTRACTION_VERSION}`]);
    const callback = vi.fn();
    await (await import('./extraction.js')).extractBatch(batchId, settings, callback);
    expect(mocks.empty).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledExactlyOnceWith(revision);
  });
});
