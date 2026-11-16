import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { extractionImage } from './extraction-image-fixtures.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `image_failures_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');

beforeAll(async () => {
  if (!url) return;
  admin = new pg.Pool({ connectionString: url });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set('options', `-c search_path=${schema},public`);
  vi.stubEnv('DATABASE_URL', scoped.toString());
  database = await import('../db.js');
  await database.migrate();
});
afterAll(async () => {
  await database?.db.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  vi.unstubAllEnvs();
});

it.skipIf(!url)('admits collected image changes without resetting failed work for observation wording alone', async () => {
  async function one(sql: string, args: unknown[] = []) {
    const row = (await database.db.query<{ id: string }>(sql, args)).rows[0];
    if (!row) throw new Error('Missing image failure fixture');
    return row.id;
  }
  const story = await one("INSERT INTO stories(chosen_excerpt) VALUES('Image report') RETURNING id");
  const source = await one("INSERT INTO sources(connector_type,external_id,name) VALUES('telegram','-100120','Image channel') RETURNING id");
  const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'1') RETURNING id", [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,'image-revision','','') RETURNING id`, [item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const evidence = [{ text: 'A screenshot announces Compiler 2.', images: [extractionImage().provenance] }];
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal,metadata)
    VALUES($1,$2,'Image report',0,$3) RETURNING id`,
  [story, revision, JSON.stringify({ extractionKind: 'image', imageEvidence: evidence })]);
  const { failureInputBoundary, failureInputsChanged } = await import('./failure-admission.js');
  const baseline = await failureInputBoundary(story, undefined, true);
  expect(baseline.inputs).toHaveLength(2);
  evidence[0]!.text = 'Compiler 2 is announced in a screenshot.';
  await database.db.query('UPDATE story_mentions SET metadata=$2 WHERE id=$1',
    [mention, JSON.stringify({ extractionKind: 'image', imageEvidence: evidence })]);
  expect(await failureInputsChanged(story, baseline)).toBe(false);
  evidence[0]!.images[0]!.sourceSha256 = 'b'.repeat(64);
  await database.db.query('UPDATE story_mentions SET metadata=$2 WHERE id=$1',
    [mention, JSON.stringify({ extractionKind: 'image', imageEvidence: evidence })]);
  expect(await failureInputsChanged(story, baseline)).toBe(true);
});
