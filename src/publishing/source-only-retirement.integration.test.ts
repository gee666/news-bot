import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const schema = `retire_links_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let sql: string;
async function one(statement: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(statement, values)).rows[0];
  if (!row) throw new Error('Missing retirement fixture');
  return row.id;
}
async function report(storyId?: string) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Reports','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id) VALUES($1,'1') RETURNING id`, [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Report text','Report text') RETURNING id`, [item, randomUUID()]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  if (storyId) await database.db.query(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
    VALUES($1,$2,'Report text',0)`, [storyId, revision]);
  return revision;
}
async function association() {
  const story = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  const revision = await report();
  const link = await one(`INSERT INTO item_links(revision_id,url) VALUES($1,'https://t.me/meme_channel') RETURNING id`, [revision]);
  await database.transaction(async client => {
    await client.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [link, story]);
    await client.query(`INSERT INTO source_link_processing(revision_id,processing_key,role)
      VALUES($1,'source_links:item-links-v1:old:m1','source_only')`, [revision]);
    await client.query(`INSERT INTO operational_state(key,value) VALUES($1,jsonb_build_object('storyId',$2::uuid))`,
      [`digest_refresh:${story}`, story]);
  });
  return { story, revision };
}
async function publication(story: string, status: 'prepared' | 'published' | 'uncertain') {
  const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,
    '{"headline":"News","score":8,"details":"Facts","detailsKind":"summary","sources":[]}') RETURNING id`, [story]);
  const id = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status,message_id,published_at)
    VALUES($1,$2,$3,$4,CASE WHEN $4='published' THEN '42' END,CASE WHEN $4='published' THEN now() END) RETURNING id`,
  [story, snapshot, randomUUID(), status]);
  const { publicationInputBoundary } = await import('./input-evidence.js');
  await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
    [`publication_input:${id}`, JSON.stringify(await publicationInputBoundary(story))]);
  return id;
}

describe.skipIf(!url)('source-only retirement migration', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    sql = await readFile(new URL('../../migrations/211_retire_source_only_links.sql', import.meta.url), 'utf8');
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE sources,stories,publications,publication_snapshots,processing_batches CASCADE');
    await database.db.query('DELETE FROM operational_state');
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('clears only attributable refresh markers without discarding genuine report work', async () => {
    const empty = await association();
    const consumed = await association(); await report(consumed.story); await publication(consumed.story, 'published');
    const newReport = await association(); await report(newReport.story); await publication(newReport.story, 'published');
    await report(newReport.story);
    const unpublished = await association(); await report(unpublished.story);
    const uncertainOwner = await association();
    await database.db.query("UPDATE operational_state SET updated_at=updated_at-interval '1 second' WHERE key=$1",
      [`digest_refresh:${uncertainOwner.story}`]);
    const unfinished = await association(); await report(unfinished.story); await publication(unfinished.story, 'published');
    const batch = await one(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES(now(),'{}',1,1) RETURNING id`);
    await database.db.query(`INSERT INTO stage_state(batch_id,story_id,stage,status) VALUES($1,$2,'generation_research','waiting')`,
      [batch, unfinished.story]);
    const unrelated = await one("INSERT INTO stories(status) VALUES('completed') RETURNING id");
    await database.db.query(`INSERT INTO operational_state(key,value) VALUES($1,jsonb_build_object('storyId',$2::uuid))`,
      [`digest_refresh:${unrelated}`, unrelated]);
    await database.db.query(sql);
    const keys = (await database.db.query<{ key: string }>("SELECT key FROM operational_state WHERE key LIKE 'digest_refresh:%' ORDER BY key")).rows.map(row => row.key);
    expect(keys).toEqual([newReport.story, unpublished.story, uncertainOwner.story, unfinished.story, unrelated]
      .map(id => `digest_refresh:${id}`).sort());
    expect(keys).not.toContain(`digest_refresh:${empty.story}`);
    expect(keys).not.toContain(`digest_refresh:${consumed.story}`);
    expect((await database.db.query('SELECT * FROM story_link_sources')).rows).toEqual([]);
    expect((await database.db.query('SELECT * FROM source_link_processing')).rows).toEqual([]);
    await database.db.query(sql);
    expect((await database.db.query<{ key: string }>("SELECT key FROM operational_state WHERE key LIKE 'digest_refresh:%' ORDER BY key")).rows.map(row => row.key)).toEqual(keys);
  });
  it('skips every unfinished retired stage but preserves completed receipts and ordinary link work', async () => {
    const f = await association();
    const batch = await one(`INSERT INTO processing_batches(cutoff_at,settings_snapshot,profile_version,model_version)
      VALUES(now(),'{}',1,1) RETURNING id`);
    for (const status of ['pending', 'running', 'waiting', 'failed', 'completed', 'skipped']) await database.db.query(`INSERT INTO stage_state
      (batch_id,revision_id,stage,status,next_retry_at,error_code,waiting_reason,outcome_unknown)
      VALUES($1,$2,$3,$4,now(),'old_failure','Old retry',true)`, [batch, f.revision, `source_links:${status}`, status]);
    await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
      VALUES($1,$2,'links:item-links-v1','waiting',now())`, [batch, f.revision]);
    const retained = (await database.db.query("SELECT * FROM stage_state WHERE status IN ('completed','skipped') OR stage LIKE 'links:%' ORDER BY id")).rows;
    await database.db.query(sql);
    expect((await database.db.query("SELECT * FROM stage_state WHERE stage IN ('source_links:completed','source_links:skipped','links:item-links-v1') ORDER BY id")).rows).toEqual(retained);
    const retired = (await database.db.query(`SELECT status,next_retry_at,error_code,waiting_reason,outcome_unknown
      FROM stage_state WHERE stage IN ('source_links:pending','source_links:running','source_links:waiting','source_links:failed')`)).rows;
    expect(retired).toEqual(Array.from({ length: 4 }, () => ({ status: 'skipped', next_retry_at: null,
      error_code: null, waiting_reason: null, outcome_unknown: false })));
  });
  it.each(['retired_only', 'extraction_failure', 'connector_error', 'connector_receipt', 'superseded', 'manual'] as const)(
    'releases only source-link-owned batch failures and deadlines: %s', async kind => {
      const f = await association();
      const batch = await one(`INSERT INTO processing_batches(status,cutoff_at,settings_snapshot,profile_version,model_version,
        next_retry_at,error_code,manual_operation_id) VALUES('waiting',now(),'{}',1,1,now()+interval '1 hour',$1,$2) RETURNING id`,
      [kind === 'connector_error' ? 'telegram_rate_limit' : 'partial_unit_failure', kind === 'manual' ? randomUUID() : null]);
      await database.db.query(`INSERT INTO batch_items(batch_id,revision_id,status,disposition_reason) VALUES($1,$2,'failed',$3)`,
        [batch, f.revision, kind === 'superseded' ? 'superseded_revision' : null]);
      await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
        VALUES($1,$2,'source_links:old','failed',now()+interval '1 hour')`, [batch, f.revision]);
      if (kind === 'extraction_failure') await database.db.query(`INSERT INTO stage_state(batch_id,revision_id,stage,status,next_retry_at)
        VALUES($1,$2,'extract:old','failed',now()+interval '1 hour')`, [batch, f.revision]);
      if (kind === 'connector_receipt') await database.db.query(`INSERT INTO request_attempts(provider,operation,attempt_number,status,next_retry_at)
        VALUES('telegram-user',$1,1,'retryable',now()+interval '1 hour')`, [batch]);
      const before = (await database.db.query('SELECT * FROM processing_batches WHERE id=$1', [batch])).rows;
      await database.db.query(sql);
      expect((await database.db.query('SELECT status FROM stage_state WHERE batch_id=$1 AND stage=$2', [batch, 'source_links:old'])).rows)
        .toEqual([{ status: 'skipped' }]);
      expect((await database.db.query('SELECT status FROM batch_items WHERE batch_id=$1', [batch])).rows)
        .toEqual([{ status: kind === 'retired_only' ? 'pending' : 'failed' }]);
      if (kind === 'retired_only') {
        expect((await database.db.query('SELECT status,next_retry_at,error_code FROM processing_batches WHERE id=$1', [batch])).rows)
          .toEqual([{ status: 'queued', next_retry_at: null, error_code: null }]);
      } else expect((await database.db.query('SELECT * FROM processing_batches WHERE id=$1', [batch])).rows).toEqual(before);
    });
  it('preserves sent snapshots and every prepared or unknown delivery record and frozen input receipt', async () => {
    for (const status of ['prepared', 'published', 'uncertain'] as const) {
      const f = await association(); await report(f.story);
      const id = await publication(f.story, status);
      if (status !== 'published') {
        await database.db.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status)
          VALUES($1,'telegram-bot','send',1,'unknown')`, [id]);
        await database.db.query(`INSERT INTO publication_media_batches(publication_id,batch_number,status) VALUES($1,0,'unknown')`, [id]);
        await database.db.query(`INSERT INTO publication_destination_reservations(destination_id,publication_id)
          SELECT destination_id,id FROM publications WHERE id=$1`, [id]);
      }
    }
    const tables = ['publications', 'publication_snapshots', 'request_attempts', 'publication_media_batches', 'publication_destination_reservations'];
    const before = await Promise.all(tables.map(async table => (await database.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows));
    const inputs = (await database.db.query("SELECT * FROM operational_state WHERE key LIKE 'publication_input:%' ORDER BY key")).rows;
    await database.db.query(sql);
    expect(await Promise.all(tables.map(async table => (await database.db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows))).toEqual(before);
    expect((await database.db.query("SELECT * FROM operational_state WHERE key LIKE 'publication_input:%' ORDER BY key")).rows).toEqual(inputs);
  });
});
