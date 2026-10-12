import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const schema = `reports_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let storyId: string;
let sourceId: string;

async function one(sql: string, args: unknown[] = []): Promise<string> {
  const result = await database.db.query<{ id: string }>(sql, args);
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Missing fixture id');
  return id;
}

async function associatedReport(text: string, classification = 'relevant') {
  const itemId = await one('INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,$2,$3) RETURNING id',
    [sourceId, randomUUID(), 'https://t.me/report/6403']);
  const revisionId = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$2,$2) RETURNING id`, [itemId, text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [itemId, revisionId]);
  // Multiple approved links from a single report must not duplicate its text.
  for (const path of ['terms', 'recap']) {
    const linkId = await one('INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id',
      [revisionId, `https://example.org/${path}`]);
    await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,$3,'test',1,'test','test')`, [linkId, storyId, classification]);
  }
  return { itemId, revisionId };
}

describe.skipIf(!url)('supplementary report database boundary', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? '');
    scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js');
    await database.migrate();
    sourceId = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram','reports','ForgetMe','public') RETURNING id");
    storyId = await one("INSERT INTO stories(chosen_excerpt,interest_score) VALUES('Pro pricing announcement',3) RETURNING id");
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('excludes stale, already-mentioned, quarantined and uncertain reports, deduplicating approved current revisions', async () => {
    const current = await associatedReport('Pro $200 now 10x Plus, previously 20x; $500 25x.');
    const stale = await associatedReport('Stale report');
    const next = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,'new','New unassociated report','New unassociated report') RETURNING id`, [stale.itemId]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [stale.itemId, next]);
    const mentioned = await associatedReport('Already mentioned');
    await database.db.query('INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,$3,0)',
      [mentioned.revisionId, storyId, 'Already mentioned']);
    const quarantined = await associatedReport('Quarantined report');
    await database.db.query("INSERT INTO operational_state(key,value) VALUES($1,'{}')", [`pipeline_failed_item:${quarantined.itemId}`]);
    const failed = await associatedReport('Failed revision');
    await database.db.query('UPDATE item_revisions SET metadata=$2 WHERE id=$1',
      [failed.revisionId, JSON.stringify({ pipelineFailure: true })]);
    await associatedReport('Uncertain report', 'uncertain');
    const { loadStory } = await import('./generation-store.js');
    expect((await loadStory(storyId)).supplementary_reports).toEqual([
      expect.objectContaining({ revision_id: current.revisionId, source_id: sourceId, access: 'public',
        text: 'Pro $200 now 10x Plus, previously 20x; $500 25x.' }),
    ]);
  });
});
