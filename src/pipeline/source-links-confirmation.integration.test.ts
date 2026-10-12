import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PiRequest } from '../models/index.js';
import { failureMetadata, ModelRequestError, RequestFault } from '../models/errors.js';
import { modelResult } from './generation.test-helpers.js';
import { sourceInputFromRequest, sourceWireVerdicts } from './source-links.test-helpers.js';
import type { AppSettings } from '../settings.js';
import type { SourceConfirmationInput, SourceVerdict } from './source-links-confirmation.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `source_confirmation_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let confirmSourceLinks: typeof import('./source-links-confirmation.js').confirmSourceLinks;
let settings: AppSettings;
let sourceId: string;
let input: SourceConfirmationInput;
const context = { id: randomUUID(), revisionId: randomUUID(), storyId: null, batchId: null, attempt: 4 };
function wireResult(request: PiRequest) {
  return sourceWireVerdicts(request, sourceInputFromRequest(request).candidates.map(({ candidate_id }): SourceVerdict => ({
    candidate_id, verdict: 'relevant', reason: 'Same supplied product.', source_quote: 'Product', story_quote: 'Product' })).reverse());
}
const generate = vi.fn(async (request: PiRequest) => modelResult(wireResult(request)));
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const result = await database.db.query<{ id: string }>(sql, args);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Missing fixture id');
  return id;
}

describe.skipIf(!url)('durable source confirmation chunks', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? '');
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    database = await import('../db.js');
    expect((await database.db.query('SELECT current_schema() AS name')).rows[0]?.name).toBe(schema);
    await database.migrate();
    ({ confirmSourceLinks } = await import('./source-links-confirmation.js'));
    settings = (await import('../settings.js')).defaultSettings;
    sourceId = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram','chunk-source','Source','public') RETURNING id");
    const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'item') RETURNING id", [sourceId]);
    await database.db.query(`INSERT INTO item_revisions(id,item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,$2,1,'fixture','Product source','Product source')`, [context.revisionId, item]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, context.revisionId]);
    const story = await one("INSERT INTO stories(status,chosen_excerpt) VALUES('completed','Product event') RETURNING id");
    input = { revision_id: context.revisionId, message: 'Product launch source with its full qualification.',
      candidates: Array.from({ length: 25 }, (_, i) => ({ candidate_id: `candidate-${i}`, story_id: story,
        link_id: randomUUID(), url: 'https://example.org/product', anchor: 'Product', story: 'Product ' + 'x'.repeat(6000) })) };
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('persists each completed chunk and resumes a later failure without replaying cached inference', async () => {
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(120_000);
    const failure = new ModelRequestError(failureMetadata(new RequestFault('timeout'), context.id, 'pi', 4, 12000));
    generate.mockImplementationOnce(async (request: PiRequest) => modelResult(wireResult(request)))
      .mockRejectedValueOnce(failure);
    await expect(confirmSourceLinks(input, settings, context, { generate })).rejects.toBe(failure);
    expect((await database.db.query('SELECT count(*)::int AS n FROM model_cache')).rows).toEqual([{ n: 1 }]);
    generate.mockClear();
    const results = await confirmSourceLinks(input, settings, { ...context, attempt: 5 }, { generate });
    expect(results.map(verdict => verdict.candidate_id)).toEqual(input.candidates.map(candidate => candidate.candidate_id));
    expect(generate).toHaveBeenCalledTimes(2);
    const firstRequest = generate.mock.calls[0]?.[0];
    if (!firstRequest) throw new Error('Missing resumed request');
    expect(sourceInputFromRequest(firstRequest).candidates[0]?.candidate_id).toBe('candidate-10');
    expect((await database.db.query('SELECT count(*)::int AS n FROM model_cache')).rows).toEqual([{ n: 3 }]);
    expect((await database.db.query("SELECT count(*)::int AS n FROM judgments WHERE stage='source_link_confirmation'")).rows)
      .toEqual([{ n: 3 }]);
    generate.mockClear();
    await confirmSourceLinks(input, settings, context, { generate });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rechecks real source access before cache reuse', async () => {
    await database.db.query("UPDATE sources SET access='restricted' WHERE id=$1", [sourceId]);
    generate.mockClear();
    const query = vi.spyOn(database.db, 'query');
    try {
      await expect(confirmSourceLinks(input, settings, context, { generate }))
        .rejects.toMatchObject({ metadata: { kind: 'invalid_request', operationId: context.id } });
      expect(query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.startsWith('SELECT value'))).toBe(false);
      expect(generate).not.toHaveBeenCalled();
    } finally { query.mockRestore(); }
  });
});
