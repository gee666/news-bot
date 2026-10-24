import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const schema = `edition_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function sent(previous?: string) {
  const id = await one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched)
    VALUES('completed','Тема','Все известные сведения','Exact source report',7,true) RETURNING id`);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one("INSERT INTO source_items(source_id,external_id) VALUES($1,'1') RETURNING id", [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Exact source report','Exact source report') RETURNING id`, [item, id]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal,metadata)
    VALUES($1,$2,'Exact source report',0,$3) RETURNING id`, [id, revision, JSON.stringify(previous ? { previous_story_id: previous } : {})]);
  if (previous) await database.db.query("INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version) VALUES($1,$2,'fixture-verified')", [id, previous]);
  const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`, [id,
    JSON.stringify({ headline: 'Тема', details: 'Все известные сведения', score: 7, detailsKind: 'summary', sources: [] })]);
  await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,status,message_id,published_at)
    VALUES($1,$2,'-100123','published',$3,now())`, [id, snapshot, String(Date.now()) + String(Math.floor(Math.random() * 10000))]);
  return { id, mention, revision };
}
async function queue(id: string) {
  await database.db.query('INSERT INTO operational_state(key,value) VALUES($1,$2)',
    [`digest_refresh:${id}`, JSON.stringify({ storyId: id })]);
}

describe.skipIf(!url)('new cumulative editions for published source enrichment', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('creates a draft from actual reports, preserves sent text and complete ancestry, and consumes the marker atomically', async () => {
    const first = await sent(); const second = await sent(first.id);
    const before = (await database.db.query('SELECT * FROM publications WHERE story_id=$1', [second.id])).rows;
    await queue(second.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    const draft = await forkPublishedRefresh(second.id);
    expect(draft).toBeTruthy(); expect(draft).not.toBe(second.id);
    expect((await database.db.query('SELECT * FROM publications WHERE story_id=$1', [second.id])).rows).toEqual(before);
    expect((await database.db.query('SELECT story_id,text,ordinal FROM story_mentions WHERE id=$1', [second.mention])).rows)
      .toEqual([{ story_id: draft, text: 'Exact source report', ordinal: 0 }]);
    const { publishedThread } = await import('./publication-thread.js');
    expect((await publishedThread(draft ?? '')).map(post => post.storyId)).toEqual([first.id, second.id]);
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${second.id}`])).rows).toEqual([]);
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${draft}`])).rows).toHaveLength(1);
    expect(await forkPublishedRefresh(second.id)).toBeNull();
  });
  it('reuses an existing unpublished edition and copies shared source associations once', async () => {
    const target = await sent();
    const draft = await one("INSERT INTO stories(status,chosen_excerpt) VALUES('processing','Exact source report') RETURNING id");
    await database.db.query("INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version) VALUES($1,$2,'fixture-verified')", [draft, target.id]);
    const link = await one("INSERT INTO item_links(revision_id,url) VALUES($1,'https://example.com/source') RETURNING id", [target.revision]);
    for (const id of [target.id, draft]) await database.db.query(`INSERT INTO story_link_sources
      (link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [link, id]);
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    expect(await forkPublishedRefresh(target.id)).toBe(draft);
    expect((await database.db.query('SELECT link_id FROM story_link_sources WHERE story_id=$1', [draft])).rows).toEqual([{ link_id: link }]);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE id=$1', [target.mention])).rows).toEqual([{ story_id: target.id }]);
  });
  it('migrates pending automatic source edits to editions without touching unknown or approved work', async () => {
    const targets = [await sent(),await sent(),await sent(),await sent()];
    const fixtures: Array<{ publication:string; desired:string; attempt:string; story:string }> = [];
    for (const [index,target] of targets.entries()) {
      const publication = await one('SELECT id FROM publications WHERE story_id=$1', [target.id]);
      const desired = await one(`INSERT INTO publication_snapshots(story_id,content)
        SELECT story_id,jsonb_set(content,'{sources}',$2::jsonb) FROM publication_snapshots
        WHERE id=(SELECT snapshot_id FROM publications WHERE id=$1) RETURNING id`, [publication,JSON.stringify([
          {url:'https://example.com/additional',label:'Additional source',primary:false,access:'public',classification:'relevant'},
        ])]);
      await database.db.query('UPDATE publications SET pending_snapshot_id=$2 WHERE id=$1', [publication,desired]);
      const attempt = await one(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
        VALUES($1,'telegram-bot','edit',1,$2,$3) RETURNING id`, [publication,index===1?'unknown':'retryable',
          JSON.stringify({snapshotId:desired,...(index===2?{approvalId:randomUUID()}:{})})]);
      if (index===3) await database.db.query("UPDATE request_attempts SET error_code='telegram_rate_limit',next_retry_at=now()+interval '10 minutes' WHERE id=$1", [attempt]);
      fixtures.push({publication,desired,attempt,story:target.id});
    }
    await database.transaction(async client => { await client.query(await readFile(new URL('../../migrations/202_cumulative_pending_editions.sql',import.meta.url),'utf8')); });
    for (const [index,fixture] of fixtures.entries()) {
      const row = (await database.db.query('SELECT pending_snapshot_id FROM publications WHERE id=$1',[fixture.publication])).rows[0];
      expect(row?.pending_snapshot_id).toBe(index===0 || index===3?null:fixture.desired);
      const attempt = (await database.db.query('SELECT status,error_code,next_retry_at FROM request_attempts WHERE id=$1',[fixture.attempt])).rows[0];
      expect(attempt).toMatchObject({status:index===0 || index===3?'failed':index===1?'unknown':'retryable'});
      if (index===0 || index===3) {
        expect(attempt?.error_code).toBe(index===3?'telegram_rate_limit':'edit_superseded');
        if (index===3) expect(attempt?.next_retry_at.getTime()).toBeGreaterThan(Date.now());
        expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1',[`digest_refresh:${fixture.story}`])).rows).toHaveLength(1);
      }
    }
  });

});
