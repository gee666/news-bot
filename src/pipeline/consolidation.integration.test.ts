import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `consolidation_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let configId: string;
let input: typeof import('./consolidation-input.js').eventInput;
let merge: typeof import('./consolidation-store.js').mergeStories;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture ID');
  return row.id;
}
async function story(text: string, vector: number[], published?: string): Promise<string> {
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('feed',$1,'Public fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,published_at,original_url)
    VALUES($1,'1',now(),'https://example.org/conference') RETURNING id`, [source]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,$3,$3) RETURNING id`, [item, randomUUID(), text]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const id = await one(`INSERT INTO stories(status,chosen_excerpt,headline,interest_score) VALUES('completed',$1,'Old',5) RETURNING id`, [text]);
  const mention = await one(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal) VALUES($1,$2,$3,0) RETURNING id`, [revision, id, text]);
  await database.db.query(`INSERT INTO embeddings(config_id,mention_id,input_hash,embedding) VALUES($1,$2,'fixture',$3::vector)`, [configId, mention, JSON.stringify(vector)]);
  const link = await one(`INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id`, [revision, `https://example.org/${id}`]);
  await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')`, [mention, link]);
  if (published) {
    const snapshot = await one(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
      [id, JSON.stringify({ headline: 'Old', score: 5, details: text, detailsKind: 'excerpt', sources: [] })]);
    await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,callback_id,status,published_at)
      VALUES($1,$2,'test',$3,$4,'published',$5)`, [id, snapshot, randomUUID(), randomUUID(), published]);
  }
  return id;
}
async function current(id: string) {
  const result = await input(id);
  if (!result) throw new Error('Missing fixture input');
  return result;
}

describe.skipIf(!databaseUrl)('same-event consolidation in isolated PostgreSQL', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl ?? '');
    url.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('EMBEDDING_DIMENSIONS', '3');
    database = await import('../db.js');
    await database.migrate();
    const configuration = await import('../settings.js');
    await configuration.saveSettings({ embeddingDimensions: 3 });
    configId = (await configuration.getActiveEmbeddingConfig()).id;
    ({ eventInput: input } = await import('./consolidation-input.js'));
    ({ mergeStories: merge } = await import('./consolidation-store.js'));
  });
  afterAll(async () => {
    if (database) await database.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });
  it('keeps earliest published message identity, all origins/links/evidence and durable aliases on restart', async () => {
    const rumor = await story('На DevDay покажут ускоренный инференс: Астра сможет работать в 8 раз быстрее.', [1, 0, 0], '2026-09-30T14:02:20.620Z');
    const announcement = await story('Запустили Ultrafast для Astra: в 8 раз быстрее, тариф $500, x25 лимиты.', [1, 0, 0], '2026-09-30T14:02:20.227Z');
    const evidence = await one(`INSERT INTO evidence_documents(url,access,expires_at)
      VALUES('https://example.org/announcement','public',now()+interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,assessment) VALUES($1,$2,'primary','Original assessment')`, [rumor, evidence]);
    const left = await current(rumor), right = await current(announcement);
    expect(await merge(left, right, 'update')).toEqual({ canonicalId: announcement, mergedId: rumor });
    expect(await merge(left, right, 'update')).toBeNull();
    expect((await database.db.query('SELECT text FROM story_mentions WHERE story_id=$1', [announcement])).rows).toHaveLength(2);
    expect((await database.db.query(`SELECT ml.* FROM mention_links ml JOIN story_mentions m ON m.id=ml.mention_id WHERE m.story_id=$1`, [announcement])).rows).toHaveLength(2);
    expect((await database.db.query('SELECT * FROM story_evidence WHERE story_id=$1', [announcement])).rows).toHaveLength(1);
    expect((await database.db.query('SELECT * FROM story_merge_evidence WHERE canonical_story_id=$1', [announcement])).rows).toHaveLength(1);
    expect((await database.db.query('SELECT status,content_version,headline FROM stories WHERE id=$1', [announcement])).rows[0])
      .toMatchObject({ status: 'processing', content_version: 2, headline: null });
    expect((await database.db.query('SELECT story_id FROM publications WHERE story_id=ANY($1::uuid[])', [[rumor, announcement]])).rows).toHaveLength(2);
    await database.db.query('DELETE FROM stories WHERE id=$1', [rumor]);
    const { canonicalStoryId } = await import('./consolidation-store.js');
    expect(await canonicalStoryId(rumor)).toBe(announcement);
    const retainedPublication = (await database.db.query(`SELECT p.story_id,a.original_story_id,a.canonical_story_id
      FROM publications p JOIN story_publication_aliases a ON a.publication_id=p.id WHERE a.original_story_id=$1`, [rumor])).rows[0];
    expect(retainedPublication).toMatchObject({ story_id: null, original_story_id: rumor, canonical_story_id: announcement });
    const plan = await story('Новый тариф дороже $200 с большими лимитами на том же DevDay.', [1, 0, 0]);
    expect(await merge(await current(plan), await current(announcement), 'update')).toEqual({ canonicalId: announcement, mergedId: plan });
    const earlier = await story('Earlier announcement of the same tier', [1, 0, 0], '2026-09-30T14:00:00.000Z');
    expect(await merge(await current(announcement), await current(earlier), 'update')).toEqual({ canonicalId: earlier, mergedId: announcement });
    expect(await canonicalStoryId(rumor)).toBe(earlier);
    expect(await canonicalStoryId(plan)).toBe(earlier);
    expect((await database.db.query('SELECT DISTINCT canonical_story_id FROM story_publication_aliases WHERE original_story_id=ANY($1::uuid[])',
      [[rumor, announcement, earlier]])).rows).toEqual([{ canonical_story_id: earlier }]);
  });
  it('unions exact known origins and every distinct supplied relevant URL without resurrecting stale links', async () => {
    const announcement = await story('Ultrafast $500 launch', [1, 0, 0]);
    const recap = await story('Ultrafast recap', [1, 0, 0]);
    const extra = await story('Ultrafast details', [1, 0, 0]);
    const rumor = await story('Eightfold inference preview', [1, 0, 0]);
    const plan = await story('Higher-limit tier preview', [1, 0, 0]);
    const ids = [announcement, recap, extra, rumor, plan];
    const origins = ['https://t.me/data_secrets/10049', 'https://t.me/data_secrets/10055',
      'https://t.me/denissexy/11703', 'https://t.me/denissexy/11700', 'https://t.me/denissexy/11700'];
    for (const [index, id] of ids.entries()) await database.db.query(`UPDATE source_items SET original_url=$2 WHERE id IN (
      SELECT r.item_id FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id WHERE m.story_id=$1)`, [id, origins[index]]);
    await database.db.query('DELETE FROM mention_links WHERE mention_id IN(SELECT id FROM story_mentions WHERE story_id=ANY($1::uuid[]))', [ids]);
    await database.db.query('UPDATE story_mentions SET story_id=$1 WHERE story_id=ANY($2::uuid[])', [announcement, [recap, extra]]);
    const retainedUrls = async () => (await database.db.query<{ url: string }>(`SELECT DISTINCT i.original_url AS url
      FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
      WHERE m.story_id=$1 UNION SELECT DISTINCT l.url FROM story_mentions m JOIN mention_links ml ON ml.mention_id=m.id
      JOIN item_links l ON l.id=ml.link_id JOIN source_items i ON i.current_revision_id=m.revision_id
      WHERE m.story_id=$1 AND ml.classification='relevant' ORDER BY url`, [announcement])).rows.map(row => row.url);
    await merge(await current(announcement), await current(rumor), 'update');
    await merge(await current(announcement), await current(plan), 'update');
    // Actual production groups 5/6/22 have four distinct origins and no assigned external URLs.
    expect(await retainedUrls()).toEqual([...new Set(origins)].sort());

    const mentions = (await database.db.query<{ id: string; revision_id: string }>(
      'SELECT id,revision_id FROM story_mentions WHERE story_id=$1 ORDER BY id', [announcement])).rows;
    const first = mentions[0], second = mentions[1];
    if (!first || !second) throw new Error('Missing merged mentions');
    const supplied = ['https://vendor.example/release', 'https://vendor.example/specifications', 'https://vendor.example/release'];
    for (const [index, url] of supplied.entries()) {
      const mention = index === 2 ? second : first;
      const link = await one('INSERT INTO item_links(revision_id,url,anchor_text) VALUES($1,$2,$3) RETURNING id',
        [mention.revision_id, url, `Source ${index}`]);
      await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')`, [mention.id, link]);
    }
    const ignored = await one(`INSERT INTO item_links(revision_id,url) VALUES($1,'https://vendor.example/unrelated') RETURNING id`, [first.revision_id]);
    await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'irrelevant')`, [first.id, ignored]);
    const itemId = await one('SELECT item_id AS id FROM item_revisions WHERE id=$1', [first.revision_id]);
    const retiredRevision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,2,$2,'Retired claim','Retired claim') RETURNING id`, [itemId, randomUUID()]);
    const retiredMention = await one(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal)
      VALUES($1,$2,'Retired claim',0) RETURNING id`, [retiredRevision, announcement]);
    const retiredLink = await one(`INSERT INTO item_links(revision_id,url) VALUES($1,'https://vendor.example/retired') RETURNING id`, [retiredRevision]);
    await database.db.query(`INSERT INTO mention_links(mention_id,link_id,classification) VALUES($1,$2,'relevant')`, [retiredMention, retiredLink]);
    const finalSibling = await story('More coverage of the same episode', [1, 0, 0]);
    await database.db.query(`UPDATE source_items SET original_url=$2 WHERE id IN(SELECT r.item_id FROM item_revisions r
      JOIN story_mentions m ON m.revision_id=r.id WHERE m.story_id=$1)`, [finalSibling, origins[0]]);
    const later = 'https://vendor.example/later';
    await database.db.query(`UPDATE item_links SET url=$2 WHERE id IN(SELECT ml.link_id FROM mention_links ml
      JOIN story_mentions m ON m.id=ml.mention_id WHERE m.story_id=$1)`, [finalSibling, later]);
    const before = (await database.db.query(`SELECT ml.* FROM mention_links ml JOIN story_mentions m ON m.id=ml.mention_id
      WHERE m.story_id=ANY($1::uuid[]) ORDER BY ml.mention_id,ml.link_id`, [[announcement, finalSibling]])).rows;
    await merge(await current(announcement), await current(finalSibling), 'same');
    const expected = [...new Set([...origins, ...supplied, later])].sort();
    expect(await retainedUrls()).toEqual(expected);
    expect((await database.db.query(`SELECT ml.* FROM mention_links ml JOIN story_mentions m ON m.id=ml.mention_id
      WHERE m.story_id=$1 ORDER BY ml.mention_id,ml.link_id`, [announcement])).rows).toEqual(before);
    const { loadStory } = await import('./generation-store.js');
    expect([...new Set((await loadStory(announcement)).links.map(link => link.url))].sort()).toEqual([...new Set([...supplied, later])].sort());
    expect((await loadStory(announcement)).mentions.map(mention => mention.text)).not.toContain('Retired claim');
  });
  it('transfers all source-only associations with winning metadata and all origin URLs', async () => {
    const canonical = await story('Release', [1, 0, 0]);
    const loser = await story('Release preview', [1, 0, 0]);
    const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
      VALUES('feed',$1,'Recap publisher','public') RETURNING id`, [randomUUID()]);
    const item = await one(`INSERT INTO source_items(source_id,external_id,published_at,original_url)
      VALUES($1,'recap',now(),'https://recap.example/origin') RETURNING id`, [source]);
    const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      VALUES($1,1,$2,'Release recap links','Release recap links') RETURNING id`, [item, randomUUID()]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
    const cases = [
      { left: 'uncertain', right: 'relevant', winner: 'right' },
      { left: 'relevant', right: 'irrelevant', winner: 'left' },
      { left: 'irrelevant', right: 'uncertain', winner: 'right' },
      { left: 'relevant', right: 'relevant', winner: 'left' },
      { left: null, right: 'irrelevant', winner: 'right' },
    ];
    const expected = [];
    for (const [index, test] of cases.entries()) {
      const link = await one('INSERT INTO item_links(revision_id,url) VALUES($1,$2) RETURNING id', [revision, `https://recap.example/link${index}`]);
      for (const [owner, classification, side] of [[canonical, test.left, 'left'], [loser, test.right, 'right']]) {
        if (classification === null) continue;
        await database.db.query(`INSERT INTO story_link_sources
          (link_id,story_id,classification,model_key,model_version,prompt_version,input_hash,assessed_at)
          VALUES($1,$2,$3,$4,7,$4,$4,'2026-09-30T00:00:00Z')`, [link, owner, classification, side]);
      }
      expected.push({ link_id: link, classification: test.winner === 'left' ? test.left : test.right,
        model_key: test.winner, model_version: 7, prompt_version: test.winner, input_hash: test.winner });
    }
    await merge(await current(canonical), await current(loser), 'update');
    const moved = (await database.db.query(`SELECT link_id,classification,model_key,model_version,prompt_version,input_hash
      FROM story_link_sources WHERE story_id=$1`, [canonical])).rows;
    expect(moved).toEqual(expect.arrayContaining(expected));
    expect(moved).toHaveLength(expected.length);
    expect((await database.db.query('SELECT * FROM story_link_sources WHERE story_id=$1', [loser])).rows).toEqual([]);
    expect((await database.db.query(`SELECT DISTINCT assessed_at FROM story_link_sources WHERE story_id=$1`, [canonical])).rows)
      .toEqual([{ assessed_at: new Date('2026-09-30T00:00:00Z') }]);
    const { loadStory } = await import('./generation-store.js');
    const loaded = await loadStory(canonical);
    expect([...new Set(loaded.links.map(link => link.url))].sort()).toEqual([
      `https://example.org/${canonical}`, `https://example.org/${loser}`,
      'https://recap.example/link0', 'https://recap.example/link1', 'https://recap.example/link3',
    ].sort());
    // Readability/authority decides publication inventory separately; merging must retain the raw associations.
    expect(loaded.links.map(link => link.url)).toContain('https://recap.example/link0');
  });
  it('archives diagnostic provenance without resurrecting superseded evidence after a merge', async () => {
    const canonical = await story('Release announcement', [1, 0, 0], '2026-09-30T14:00:00Z');
    const sibling = await story('Release detail', [1, 0, 0]);
    const evidence = await one(`INSERT INTO evidence_documents(url,access,expires_at)
      VALUES('https://example.org/old-diagnostic','unavailable',now()+interval '1 day') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,assessment,superseded_at)
      VALUES($1,$2,'candidate','uncertain','Failed original read',now())`, [sibling, evidence]);
    await merge(await current(canonical), await current(sibling), 'update');
    expect((await database.db.query('SELECT evidence_id FROM story_evidence WHERE story_id=$1 AND superseded_at IS NULL', [canonical])).rows).toEqual([]);
    expect((await database.db.query('SELECT assessment,superseded_at IS NOT NULL AS superseded FROM story_evidence WHERE story_id=$1 AND evidence_id=$2', [canonical, evidence])).rows)
      .toEqual([{ assessment: 'Failed original read', superseded: true }]);
    expect((await database.db.query('SELECT merged_story_id,assessment FROM story_merge_evidence WHERE evidence_id=$1', [evidence])).rows)
      .toEqual([{ merged_story_id: sibling, assessment: 'Failed original read' }]);
  });
  it('retains artifact and hosting links in event decisions and rejects merges after their identity changes', async () => {
    const artifact = await story('GLM-5.3 uncensored checkpoint released', [1, 0, 0]);
    const hosted = await story('GLM-5.3 uncensored hosted API for $20', [1, 0, 0]);
    const artifactUrl = 'https://huggingface.co/Infatoshi/GLM-5.3-UNCENSORED-EXL3-3.0bpw';
    await database.db.query(`UPDATE item_links SET url=$2 WHERE revision_id IN(
      SELECT revision_id FROM story_mentions WHERE story_id=$1)`, [artifact, artifactUrl]);
    await database.db.query(`UPDATE item_links SET url='https://abliteration.ai/' WHERE revision_id IN(
      SELECT revision_id FROM story_mentions WHERE story_id=$1)`, [hosted]);
    const left = await current(artifact), right = await current(hosted);
    expect([left.reports,right.reports]).toEqual(expect.arrayContaining([
      expect.arrayContaining([expect.objectContaining({ links: [artifactUrl] })]),
      expect.arrayContaining([expect.objectContaining({ links: ['https://abliteration.ai/'] })]),
    ]));
    await database.db.query(`UPDATE mention_links SET classification='irrelevant' WHERE mention_id IN(
      SELECT id FROM story_mentions WHERE story_id=$1)`, [hosted]);
    expect((await current(hosted)).fingerprint).not.toBe(right.fingerprint);
    expect(await merge(left, right, 'update')).toBeNull();
  });
});
