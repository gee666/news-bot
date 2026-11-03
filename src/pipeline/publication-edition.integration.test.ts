import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `edition_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function sent(previous?: string, ageDays = 0, options: { legacy?: boolean; supplementary?: boolean } = {}) {
  const id = await one(`INSERT INTO stories(status,headline,summary,chosen_excerpt,interest_score,researched)
    VALUES('completed','Тема','Все известные сведения','Exact source report',7,true) RETURNING id`);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Fixture','public') RETURNING id`, [randomUUID()]);
  const originalUrl = `https://example.org/report/${id}`;
  const item = await one(`INSERT INTO source_items(source_id,external_id,published_at,original_url)
    VALUES($1,'1',now()-$2*interval '1 day',$3) RETURNING id`, [source, ageDays, originalUrl]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Exact source report','Exact source report') RETURNING id`, [item, id]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal,metadata)
    VALUES($1,$2,'Exact source report',0,$3) RETURNING id`, [id, revision, JSON.stringify(previous ? { previous_story_id: previous } : {})]);
  if (previous) await database.db.query("INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version) VALUES($1,$2,'fixture-verified')", [id, previous]);
  const supplementary = options.supplementary ? await supplement(id) : null;
  const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`, [id,
    JSON.stringify({ headline: 'Тема', details: 'Все известные сведения', score: 7, detailsKind: 'summary',
      sources: [{ url: originalUrl, label: 'Original report', primary: false, access: 'public', classification: 'relevant' }] })]);
  const publication = await one(`INSERT INTO publications(story_id,snapshot_id,destination_id,status)
    VALUES($1,$2,'-100123','prepared') RETURNING id`, [id, snapshot]);
  if (!options.legacy) {
    const { recordPublicationInputs } = await import('../publishing/input-admission.js');
    await database.transaction(client => recordPublicationInputs(client, publication, id, { newPreparation: true }));
  }
  await database.db.query(`UPDATE publications SET status='published',message_id=$2,published_at=now() WHERE id=$1`,
    [publication, randomUUID()]);
  return { id, mention, revision, item, snapshot, publication, supplementary };
}
async function supplement(storyId: string, ageDays = 0) {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Secondary coverage','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url,published_at)
    VALUES($1,'1',$2,now()-$3*interval '1 day') RETURNING id`, [source, `https://example.org/${randomUUID()}`, ageDays]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Independent secondary report','Independent secondary report') RETURNING id`, [item, randomUUID()]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const link = await one('INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id', [revision, `https://example.org/${randomUUID()}`]);
  await associate(storyId, link);
  return { item, revision, link };
}
async function associate(storyId: string, link: string) {
  await database.db.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
    VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [link, storyId]);
}
async function revise(target: Awaited<ReturnType<typeof sent>>, text: string) {
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
    VALUES($1,2,$2,$3,$3,'{"parserVersion":2}') RETURNING id`, [target.item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [target.item, revision]);
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
    VALUES($1,$2,$3,0) RETURNING id`, [target.id, revision, text]);
  return { revision, mention };
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
    settings = await (await import('../settings.js')).getSettings();
  });
  afterAll(async () => {
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('creates a draft from actual reports, preserves sent text and complete ancestry, and consumes the marker atomically', async () => {
    const first = await sent(); const second = await sent(first.id);
    const before = (await database.db.query('SELECT * FROM publications WHERE story_id=$1', [second.id])).rows;
    await supplement(second.id);
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
    const { link } = await supplement(target.id);
    await associate(draft, link);
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    expect(await forkPublishedRefresh(target.id)).toBe(draft);
    expect((await database.db.query('SELECT link_id FROM story_link_sources WHERE story_id=$1', [draft])).rows).toEqual([{ link_id: link }]);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE id=$1', [target.mention])).rows).toEqual([{ story_id: target.id }]);
  });
  it.each([13, 5])('consumes an unchanged %i-day-old report marker without touching published history', async ageDays => {
    const target = await sent(undefined, ageDays);
    const evidence = await one(`INSERT INTO evidence_documents(url,content,access,expires_at)
      VALUES('https://example.org/retained','Original evidence','public',now()-interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance)
      VALUES($1,$2,'primary','relevant')`, [target.id, evidence]);
    const queries = [
      'SELECT * FROM stories WHERE id=$1', 'SELECT * FROM publications WHERE story_id=$1',
      'SELECT * FROM publication_snapshots WHERE story_id=$1', 'SELECT * FROM story_mentions WHERE story_id=$1',
      'SELECT * FROM story_evidence WHERE story_id=$1',
    ];
    const before = await Promise.all(queries.map(sql => database.db.query(sql, [target.id]).then(result => result.rows)));
    const count = (await database.db.query('SELECT count(*) FROM stories')).rows;
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    expect(await forkPublishedRefresh(target.id, { ...settings, modelVersion: settings.modelVersion + 1,
      profileVersion: settings.profileVersion + 1 })).toBeNull();
    expect(await Promise.all(queries.map(sql => database.db.query(sql, [target.id]).then(result => result.rows)))).toEqual(before);
    expect((await database.db.query('SELECT count(*) FROM stories')).rows).toEqual(count);
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${target.id}`])).rows).toEqual([]);
  });
  it('does not treat a metadata-only revision or refreshed source classification as a new report', async () => {
    const target = await sent(undefined, 13, { supplementary: true });
    const source = target.supplementary;
    if (!source) throw new Error('Missing supplementary fixture');
    await database.db.query(`UPDATE story_link_sources SET classification='irrelevant' WHERE story_id=$1`, [target.id]);
    await database.db.query(`UPDATE story_link_sources SET classification='relevant',model_version=2,assessed_at=now() WHERE story_id=$1`, [target.id]);
    await revise(target, 'Exact source report');
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    expect(await forkPublishedRefresh(target.id, settings)).toBeNull();
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE revision_id=$1', [target.revision])).rows).toEqual([{ story_id: target.id }]);
    expect((await database.db.query('SELECT link_id FROM story_link_sources WHERE story_id=$1', [target.id])).rows).toEqual([{ link_id: source.link }]);
  });
  it('allows a meaningful update to a previously published old report and preserves both revisions', async () => {
    const target = await sent(undefined, 13);
    const edited = await revise(target, 'Corrected primary report with new results');
    const snapshot = (await database.db.query('SELECT * FROM publication_snapshots WHERE id=$1', [target.snapshot])).rows;
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    const draft = await forkPublishedRefresh(target.id, settings);
    expect(draft).toBeTruthy();
    expect((await database.db.query('SELECT id,text,metadata FROM story_mentions WHERE story_id=$1 ORDER BY created_at,id', [draft])).rows)
      .toEqual([
        { id: target.mention, text: 'Exact source report', metadata: { previous_story_id: target.id } },
        { id: edited.mention, text: 'Corrected primary report with new results', metadata: { previous_story_id: target.id } },
      ]);
    expect((await database.db.query('SELECT * FROM publication_snapshots WHERE id=$1', [target.snapshot])).rows).toEqual(snapshot);
  });
  it('rejects a newly attached old article despite its new association and extraction timestamps', async () => {
    const target = await sent(undefined, 13);
    await supplement(target.id, 5);
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    expect(await forkPublishedRefresh(target.id, settings)).toBeNull();
  });
  it('copies genuinely new secondary-only coverage queued on an older published ancestor', async () => {
    const first = await sent(undefined, 13); const latest = await sent(first.id, 5);
    const { link } = await supplement(first.id);
    await queue(first.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    const draft = await forkPublishedRefresh(first.id, settings);
    expect(draft).toBeTruthy();
    expect((await database.db.query('SELECT previous_story_id FROM story_publication_threads WHERE story_id=$1', [draft])).rows)
      .toEqual([{ previous_story_id: latest.id }]);
    expect((await database.db.query('SELECT link_id FROM story_link_sources WHERE story_id=$1', [draft])).rows).toEqual([{ link_id: link }]);
    expect((await database.db.query('SELECT story_id FROM story_mentions WHERE id=$1', [latest.mention])).rows).toEqual([{ story_id: draft }]);
  });
  it('admits new coverage already owned by an existing draft but leaves an unchanged draft intact', async () => {
    const target = await sent();
    const draft = await one(`INSERT INTO stories(status,chosen_excerpt,headline,summary)
      VALUES('completed','Exact source report','Existing title','Existing summary') RETURNING id`);
    await database.db.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
      VALUES($1,$2,'fixture-verified')`, [draft, target.id]);
    const before = (await database.db.query('SELECT * FROM stories WHERE id=$1', [draft])).rows;
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    await queue(target.id);
    expect(await forkPublishedRefresh(target.id, settings)).toBeNull();
    expect((await database.db.query('SELECT * FROM stories WHERE id=$1', [draft])).rows).toEqual(before);
    await supplement(draft);
    await queue(target.id);
    expect(await forkPublishedRefresh(target.id, settings)).toBe(draft);
  });
  it.each(['missing', 'invalid', 'partial_thread', 'revision_revert'] as const)(
    'leaves %s legacy history untouched and consumes refresh with an explicit hold', async legacy => {
      const first = await sent(undefined, 13, { legacy: legacy !== 'invalid' });
      const target = legacy === 'partial_thread' ? await sent(first.id, 5) : first;
      if (legacy === 'invalid') await database.db.query(`UPDATE operational_state SET value='{"version":"publication-input-v1","inputs":[]}'
        WHERE key=$1`, [`publication_input:${first.publication}`]);
      if (legacy === 'revision_revert') {
        await revise(target, 'Intermediate revision');
        await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [target.item, target.revision]);
      }
      const precollected = await supplement(target.id);
      await database.db.query(`UPDATE source_items SET collected_at=
        (SELECT published_at FROM publications WHERE id=$2)-interval '1 hour' WHERE id=$1`,
      [precollected.item, target.publication]);
      const queries = ['SELECT * FROM stories WHERE id=$1', 'SELECT * FROM publications WHERE story_id=$1',
        'SELECT * FROM publication_snapshots WHERE story_id=$1', 'SELECT * FROM story_mentions WHERE story_id=$1'];
      const before = await Promise.all(queries.map(sql => database.db.query(sql, [target.id]).then(result => result.rows)));
      await queue(target.id);
      const { forkPublishedRefresh } = await import('./publication-edition.js');
      expect(await forkPublishedRefresh(target.id, settings)).toBeNull();
      expect(await Promise.all(queries.map(sql => database.db.query(sql, [target.id]).then(result => result.rows)))).toEqual(before);
      expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${target.id}`])).rows).toEqual([]);
      expect((await database.db.query('SELECT value FROM operational_state WHERE key=$1', [`publication_refresh_hold:${target.id}`])).rows)
        .toEqual([{ value: { storyId: target.id, latestStoryId: target.id, reason: 'publication_input_unverifiable' } }]);
      expect(await forkPublishedRefresh(target.id, settings)).toBeNull();
    });
  it('forks fresh independent coverage after a legacy post without reconstructing its input history', async () => {
    const target = await sent(undefined, 13, { legacy: true });
    const queries = ['SELECT * FROM publications WHERE story_id=$1', 'SELECT * FROM publication_snapshots WHERE story_id=$1'];
    const before = await Promise.all(queries.map(sql => database.db.query(sql, [target.id]).then(result => result.rows)));
    const { link } = await supplement(target.id);
    await queue(target.id);
    const { forkPublishedRefresh } = await import('./publication-edition.js');
    const draft = await forkPublishedRefresh(target.id, settings);
    expect(draft).toBeTruthy(); expect(draft).not.toBe(target.id);
    expect((await database.db.query('SELECT previous_story_id FROM story_publication_threads WHERE story_id=$1', [draft])).rows)
      .toEqual([{ previous_story_id: target.id }]);
    expect((await database.db.query('SELECT link_id FROM story_link_sources WHERE story_id=$1', [draft])).rows).toEqual([{ link_id: link }]);
    expect(await Promise.all(queries.map(sql => database.db.query(sql, [target.id]).then(result => result.rows)))).toEqual(before);
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=ANY($1::text[])',
      [[`publication_input:${target.publication}`, `publication_refresh_hold:${target.id}`, `digest_refresh:${target.id}`]])).rows).toEqual([]);
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${draft}`])).rows).toHaveLength(1);
    expect(await forkPublishedRefresh(target.id, settings)).toBeNull();
  });
  it('does not regenerate a published unchanged story during a settings-driven digest refresh', async () => {
    const target = await sent(undefined, 13);
    await queue(target.id);
    const { refreshDigest } = await import('./stories.js');
    const { Judgments } = await import('./judgments.js');
    const changedSettings = { ...settings, modelVersion: settings.modelVersion + 1 };
    const judgments = new Judgments(changedSettings);
    const judge = vi.spyOn(judgments, 'judge');
    try {
      expect(await refreshDigest(changedSettings, judgments, [target.id]))
        .toEqual({ completedStories: 0, failedStories: 0, skippedStories: 0 });
      expect(judge).not.toHaveBeenCalled();
    } finally { await judgments.close(); }
    expect((await database.db.query('SELECT key FROM operational_state WHERE key=$1', [`digest_refresh:${target.id}`])).rows).toEqual([]);
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
