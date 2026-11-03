import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicationBoundary } from './input-evidence.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `scoped_inputs_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let evidence: typeof import('./input-evidence.js');
let admission: typeof import('./input-admission.js');
let alpha: string;
let beta: string;
let item: string;
let revisionNumber: number;
const primaryUrl = 'https://example.org/alpha';
const otherUrl = 'https://example.org/beta';
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Fixture missing');
  return row.id;
}
type Link = { url: string; target: 'alpha' | 'beta' | 'source-only' | 'uncertain' | 'unassigned' };
async function replace(raw: string, alphaText: string | null, betaText: string | null, links: Link[]) {
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,$2,$3,$4,$4) RETURNING id`, [item, ++revisionNumber, randomUUID(), raw]);
  await database.db.query('DELETE FROM story_mentions WHERE story_id=ANY($1::uuid[])', [[alpha, beta]]);
  await database.db.query('DELETE FROM story_link_sources WHERE story_id=ANY($1::uuid[])', [[alpha, beta]]);
  const mentions: Partial<Record<'alpha' | 'beta', string>> = {};
  for (const [target, story, text] of [['alpha', alpha, alphaText], ['beta', beta, betaText]] as const) {
    if (text !== null) mentions[target] = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal)
      VALUES($1,$2,$3,$4) RETURNING id`, [story, revision, text, target === 'alpha' ? 0 : 1]);
  }
  for (const [index, link] of links.entries()) {
    const id = await one(`INSERT INTO item_links(revision_id,url,anchor_text,start_offset,end_offset)
      VALUES($1,$2,'link',$3,$4) RETURNING id`, [revision, link.url, index * 5, index * 5 + 4]);
    if (link.target === 'source-only') await database.db.query(`INSERT INTO story_link_sources
      (link_id,story_id,classification,model_key,model_version,prompt_version,input_hash)
      VALUES($1,$2,'relevant','fixture',1,'fixture','fixture')`, [id, alpha]);
    else if (link.target !== 'unassigned') await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification)
      VALUES($1,$2,$3)`, [mentions[link.target === 'beta' ? 'beta' : 'alpha'], id,
      link.target === 'uncertain' ? 'uncertain' : 'relevant']);
  }
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
}
async function current(storyId = alpha) { return evidence.publicationInputBoundary(storyId); }
const compare = (next: PublicationBoundary, prior: PublicationBoundary) =>
  admission.admitPublicationInputs(next, prior, true, true, 48);

describe.skipIf(!url)('story-scoped collected publication evidence', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    evidence = await import('./input-evidence.js'); admission = await import('./input-admission.js');
  });
  beforeEach(async () => {
    await database.db.query('TRUNCATE sources,stories CASCADE');
    await database.db.query('DELETE FROM operational_state');
    alpha = await one("INSERT INTO stories(status) VALUES('processing') RETURNING id");
    beta = await one("INSERT INTO stories(status) VALUES('processing') RETURNING id");
    const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
      VALUES('telegram',$1,'Multi-event reports','public') RETURNING id`, [randomUUID()]);
    item = await one(`INSERT INTO source_items(source_id,external_id,published_at)
      VALUES($1,'1',now()-interval '13 days') RETURNING id`, [source]);
    revisionNumber = 0;
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('isolates extracted event text and relevant URLs from a multi-event parent report', async () => {
    await replace('Alpha released. Beta costs 10.', 'Alpha released', 'Beta costs 10',
      [{ url: primaryUrl, target: 'alpha' }, { url: otherUrl, target: 'beta' }]);
    const before = await current();
    expect(before.inputs.map(input => input.payload)).toEqual([
      { kind: 'text', tokens: ['alpha', 'released'] }, { kind: 'url', url: primaryUrl },
    ]);
    expect(before.inputs[0]?.collectedTokens).toContain('beta');
    expect(before.inputs[0]?.collectedUrls).toEqual([primaryUrl, otherUrl]);
    const priorBeta = await current(beta);
    await replace('Alpha released. Beta costs 20.', 'Alpha released', 'Beta costs 20',
      [{ url: primaryUrl, target: 'alpha' }, { url: `${otherUrl}/new`, target: 'beta' }]);
    expect(compare(await current(), before)).toEqual({ allowed: false, reason: 'no_new_source_input' });
    expect(compare(await current(beta), priorBeta)).toEqual({ allowed: true });
  });
  it('does not authorize expanded extraction of text already present in the immutable collection', async () => {
    const raw = 'Alpha released. Beta costs 10.';
    await replace(raw, 'Alpha released', 'Beta costs 10', []);
    const before = await current();
    await replace(raw, 'Alpha released. Beta costs 10.', 'Beta costs 10', []);
    expect(compare(await current(), before)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not authorize newly relevant classification of a previously collected URL', async () => {
    await replace('Alpha released', 'Alpha released', null, [{ url: primaryUrl, target: 'uncertain' }]);
    const before = await current();
    expect(before.inputs).toHaveLength(1);
    await replace('Alpha released', 'Alpha released', null, [{ url: primaryUrl, target: 'alpha' }]);
    expect(compare(await current(), before)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not turn an existing ineligible URL into new collection input after parser-policy changes', async () => {
    await replace('Alpha released', 'Alpha released', null, [{ url: primaryUrl, target: 'uncertain' }]);
    await database.db.query(`UPDATE item_links SET metadata='{"evidenceEligible":false}'::jsonb WHERE url=$1`, [primaryUrl]);
    const before = await current();
    expect(before.inputs.map(input => input.payload)).toEqual([{ kind: 'text', tokens: ['alpha', 'released'] }]);
    expect(before.inputs[0]?.collectedUrls).toContain(primaryUrl);
    await database.db.query(`UPDATE item_links SET metadata='{"evidenceEligible":true}'::jsonb WHERE url=$1`, [primaryUrl]);
    await database.db.query("UPDATE mention_links SET classification='relevant'");
    const after = await current();
    expect(after.inputs.map(input => input.payload)).toContainEqual({ kind: 'url', url: primaryUrl });
    expect(compare(after, before)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('allows a new relevant URL backed by a real collected URL addition', async () => {
    await replace('Alpha released', 'Alpha released', null, []);
    const before = await current();
    await replace('Alpha released', 'Alpha released', null, [{ url: primaryUrl, target: 'alpha' }]);
    expect(compare(await current(), before)).toEqual({ allowed: true });
  });
  it('source-only coverage never uses unrelated parent text changes as publication input', async () => {
    await replace('Alpha released. Beta costs 10.', null, 'Beta costs 10', [{ url: primaryUrl, target: 'source-only' }]);
    const before = await current();
    expect(before.inputs.map(input => input.payload)).toEqual([{ kind: 'url', url: primaryUrl }]);
    await replace('Alpha released. Beta costs 20.', null, 'Beta costs 20', [{ url: primaryUrl, target: 'source-only' }]);
    expect(compare(await current(), before)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('does not let unrelated collected additions authorize re-extracted existing event content', async () => {
    await replace('Alpha released. Beta costs 10.', 'Alpha released', 'Beta costs 10', []);
    const before = await current();
    await replace('Alpha released. Beta costs 10. Gamma launched.', 'Alpha released. Beta costs 10.', 'Beta costs 10', []);
    expect(compare(await current(), before)).toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
  it('allows a proven scoped decimal update to an old primary', async () => {
    await replace('Alpha costs 1.5 million. Beta unchanged.', 'Alpha costs 1.5 million', 'Beta unchanged', []);
    const before = await current();
    await replace('Alpha costs 15 million. Beta unchanged.', 'Alpha costs 15 million', 'Beta unchanged', []);
    expect(compare(await current(), before)).toEqual({ allowed: true });
  });
});
