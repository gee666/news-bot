import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StoryContent } from './store.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `read_quality_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let snapshotFor: typeof import('./store.js').snapshotFor;
let expectedSourceUrls: typeof import('./preview-sources.js').expectedSourceUrls;
let settings: import('../settings.js').AppSettings;
async function one(sql: string, args: unknown[] = []): Promise<string> {
  const id = (await database.db.query<{ id: string }>(sql, args)).rows[0]?.id;
  if (!id) throw new Error('Missing fixture'); return id;
}
async function story(): Promise<StoryContent> {
  const id = await one("INSERT INTO stories(status,headline,summary,interest_score,researched) VALUES('completed','Research finding','Author findings',5,false) RETURNING id");
  const source = await one("INSERT INTO sources(connector_type,external_id,name,access) VALUES('telegram',$1,'Read reporter','public') RETURNING id", [randomUUID()]);
  const item = await one("INSERT INTO source_items(source_id,external_id,original_url) VALUES($1,'1','https://t.me/reporter/1') RETURNING id", [source]);
  const revision = await one("INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text) VALUES($1,1,'news','Actual report of research findings','Actual report of research findings') RETURNING id", [item]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one("INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,'Actual report of research findings',0) RETURNING id", [id, revision]);
  for (const [target,anchor] of [['https://arxiv.org/abs/2609.16247','paper'],['https://max.ru/promotions','Мы в Макс']]) {
    const link = await one('INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,$3) RETURNING id', [revision,target,anchor]);
    await database.db.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')", [mention,link]);
  }
  return { id, headline: 'Research finding', summary: 'Author findings', chosen_excerpt: null,
    translated_excerpt: 'Fixture details', interest_score: 5, researched: false };
}
async function evidence(storyId: string, options: {
  url: string; title?: string; content?: string | null; access?: string; role?: string;
  relevance?: string; verified?: boolean; expired?: boolean;
}) {
  const id = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at,metadata)
    VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now()-interval '1 second' ELSE now()+interval '1 day' END,
      '{"researchInputHash":"old-policy"}') RETURNING id`,
  [options.url, options.title ?? 'Actual document title', options.content === undefined ? 'Original findings reported by authors.' : options.content,
    options.access ?? 'public', options.expired ?? false]);
  await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at,assessed_at,assessment)
    VALUES($1,$2,$3,$4,CASE WHEN $5 THEN now() ELSE NULL END,now(),'Specific event assessment')`,
  [storyId,id,options.role ?? 'supporting',options.relevance ?? 'relevant',options.verified ?? true]);
  return id;
}

describe.skipIf(!url)('read-source publication and diagnostic history', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    settings = await (await import('../settings.js')).getSettings();
    ({ snapshotFor } = await import('./store.js'));
    ({ expectedSourceUrls } = await import('./preview-sources.js'));
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('reproduces msg28 unread/login/ad bypasses without publishing any of them', async () => {
    const current = await story();
    await evidence(current.id, { url: 'https://arxiv.org/abs/2609.16247', title: 'The Pain Axis: LLMs Represent Self-Directed Harm and Act on It', role: 'primary' });
    for (const options of [
      { url: 'https://x.com/reporter/status/1', access: 'unavailable', content: null },
      { url: 'https://github.com/login?return_to=repo', title: 'Sign in to GitHub · GitHub', content: 'Username Password' },
      { url: 'https://publisher.org/error', title: 'This page couldn’t load', content: 'Reload' },
      { url: 'https://publisher.org/uncertain', relevance: 'uncertain' },
      { url: 'https://publisher.org/unverified', verified: false },
      { url: 'https://publisher.org/expired', expired: true },
      { url: 'https://publisher.org/unrelated', relevance: 'irrelevant' },
      { url: 'javascript:alert(1)' },
    ]) await evidence(current.id, options);
    const sources = (await snapshotFor(database.db, current)).sources;
    expect(sources.map(source => source.url)).toEqual(['https://arxiv.org/abs/2609.16247','https://t.me/reporter/1']);
    expect(sources[0]).toMatchObject({ primary: true, access: 'public', classification: 'relevant', label: 'The Pain Axis: LLMs Represent Self-Directed Harm and Act on It' });
    expect(await expectedSourceUrls(database.db,current.id,current)).toEqual(new Set(sources.map(source => source.url)));
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1', [current.id])).rows).toHaveLength(9);
  });

  it('lets a read relevant primary assessment supersede an earlier irrelevant link decision', async () => {
    const current = await story();
    await database.db.query("UPDATE mention_links ml SET classification='irrelevant' FROM item_links l WHERE ml.link_id=l.id AND l.url='https://arxiv.org/abs/2609.16247'");
    await evidence(current.id, { url: 'https://arxiv.org/abs/2609.16247', role: 'primary' });
    expect((await snapshotFor(database.db, current)).sources.some(source => source.primary)).toBe(true);
    expect(await expectedSourceUrls(database.db,current.id,current)).toContain('https://arxiv.org/abs/2609.16247');
  });

  it('preserves failed read attribution through retry expiry, policy invalidation and cleanup', async () => {
    const current = await story();
    const diagnostic = await evidence(current.id, { url: 'https://publisher.org/blocked', access: 'restricted', content: null, role: 'candidate', relevance: 'uncertain', verified: false, expired: true });
    const { loadEvidence } = await import('../pipeline/generation-store.js');
    const { resetResearchFixture } = await import('../pipeline/generation.test-helpers.js');
    expect(await loadEvidence(current.id,'new-policy')).toEqual([]);
    await resetResearchFixture(current.id);
    const { cleanup } = await import('../pipeline/retention.js');
    await cleanup(settings);
    expect((await database.db.query('SELECT evidence_id,superseded_at IS NOT NULL AS superseded FROM story_evidence WHERE story_id=$1 AND evidence_id=$2', [current.id,diagnostic])).rows)
      .toEqual([{ evidence_id: diagnostic, superseded: true }]);
    expect((await database.db.query('SELECT access,content FROM evidence_documents WHERE id=$1', [diagnostic])).rows).toEqual([{ access: 'restricted', content: null }]);
    expect((await snapshotFor(database.db,current)).sources.some(source => source.url === 'https://publisher.org/blocked')).toBe(false);
  });

  it('migrates only disabled-search settings while preserving the user profile and custom choices', async () => {
    const migration = await readFile(new URL('../../migrations/100_source_research_defaults.sql', import.meta.url), 'utf8');
    for (const [threshold,searches,nextThreshold,nextSearches] of [[7,0,5,2],[3,0,3,2],[8,3,8,3]]) {
      const before = { ...settings, interestProfile: 'My specific hardware and science profile', profileVersion: 11, modelVersion: 12,
        researchThreshold: threshold, researchMaxSearches: searches };
      await database.db.query('UPDATE app_settings SET value=$1 WHERE id=1', [JSON.stringify(before)]);
      await database.db.query(migration);
      const after = (await database.db.query<{ value: unknown }>('SELECT value FROM app_settings WHERE id=1')).rows[0]?.value;
      expect(after).toEqual({ ...before, researchThreshold: nextThreshold, researchMaxSearches: nextSearches });
    }
  });
});
