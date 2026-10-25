import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('./download.js', async original => ({ ...await original<typeof import('./download.js')>(), downloadMedia: mocks.download }));
vi.mock('./comparison.js', async original => ({ ...await original<typeof import('./comparison.js')>(),
  deduplicateMedia: async (items: unknown[]) => items }));
const url = process.env.TEST_DATABASE_URL;
const schema = `storymedia_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let service: typeof import('./story-media.js');
let settings: import('../settings.js').AppSettings;
const stories: string[] = [];
async function id(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}

async function story(previous?: string): Promise<string> {
  const storyId = await id("INSERT INTO stories(status) VALUES('completed') RETURNING id");
  stories.push(storyId);
  await database.db.query("INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version) VALUES($1,$2,'test-same-v1')", [storyId, previous ?? null]);
  return storyId;
}
async function report(storyId: string, name: string, role: 'mention' | 'supplement', access = 'public') {
  const source = await id("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test',$2) RETURNING id", [randomUUID(), access]);
  const item = await id('INSERT INTO source_items(source_id,external_id,retention_at) VALUES($1,$2,now()) RETURNING id', [source, randomUUID()]);
  const revision = await id(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
    VALUES($1,1,$2,'Test','Test',$3) RETURNING id`, [item, randomUUID(), JSON.stringify({ media: [{ type: 'image', url: `https://example.org/${name}.png` }] })]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  if (role === 'mention') await database.db.query("INSERT INTO story_mentions(story_id,revision_id,text,ordinal) VALUES($1,$2,'Test',0)", [storyId, revision]);
  else {
    const link = await id("INSERT INTO item_links(revision_id,url) VALUES($1,'https://example.org/story') RETURNING id", [revision]);
    await database.db.query("INSERT INTO story_link_sources(story_id,link_id,classification,model_key,model_version,prompt_version,input_hash) VALUES($1,$2,'relevant','test',1,'test','hash')", [storyId, link]);
  }
  return { source, item, revision };
}
async function retire(item: string) {
  const revision = await id(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,2,$2,'Revised without media','Revised without media') RETURNING id`, [item, randomUUID()]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
}

describe.skipIf(!url)('story media current-evidence selection', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: url }); await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(url ?? ''); scoped.searchParams.set('options', `-c search_path=${schema},public`);
    vi.stubEnv('DATABASE_URL', scoped.toString());
    database = await import('../db.js'); await database.migrate();
    settings = (await import('../settings.js')).defaultSettings;
    service = await import('./story-media.js');
  });
  beforeEach(() => { mocks.download.mockReset(); mocks.download.mockResolvedValue({ type: 'image', mimeType: 'image/png', data: Buffer.from('image') }); });
  afterAll(async () => {
    for (const story of stories) await service.releaseStoryMedia(story);
    await database?.db.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    vi.unstubAllEnvs();
  });

  it('collapses the original and WordPress rendition from one retained source before caching', async () => {
    const storyId = await story();
    const { revision } = await report(storyId, 'wordpress', 'mention');
    const url = 'https://blogs.nvidia.com/wp-content/uploads/2026/10/NVIDIA-European-Retail.jpg';
    await database.db.query('UPDATE item_revisions SET metadata=$2 WHERE id=$1', [revision, JSON.stringify({ media: [
      { type: 'image', url: url.replace('.jpg', '-842x450.jpg') }, { type: 'image', url },
    ] })]);
    expect(await service.publicationMedia(storyId, settings)).toHaveLength(1);
    expect(mocks.download).toHaveBeenCalledExactlyOnceWith({ type: 'image', url }, { metadata: {} });
    expect(await service.publicationMedia(storyId, settings)).toHaveLength(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });

  it('loads relevant supplementary source attachments without requiring story mentions', async () => {
    const story = await id("INSERT INTO stories(status) VALUES('completed') RETURNING id"); stories.push(story);
    const source = await id("INSERT INTO sources(connector_type,external_id,name,access) VALUES('feed',$1,'Test','public') RETURNING id", [randomUUID()]);
    const item = await id('INSERT INTO source_items(source_id,external_id,retention_at) VALUES($1,$2,now()) RETURNING id', [source, randomUUID()]);
    const revision = await id(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text,metadata)
      VALUES($1,1,'hash','Test','Test',$2) RETURNING id`, [item, JSON.stringify({ media: [{ type: 'image', url: 'https://example.org/supplement.png' }] })]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
    const link = await id("INSERT INTO item_links(revision_id,url,anchor_text,start_offset,end_offset) VALUES($1,'https://example.org/story','story',0,5) RETURNING id", [revision]);
    await database.db.query("INSERT INTO story_link_sources(story_id,link_id,classification,model_key,model_version,prompt_version,input_hash) VALUES($1,$2,'relevant','test',1,'test','hash')", [story, link]);
    const media = await service.publicationMedia(story, settings);
    expect(media).toHaveLength(1);
    expect(mocks.download).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.org/supplement.png' }), expect.anything());
    await service.releaseStoryMedia(story);
    await database.db.query("UPDATE story_link_sources SET classification='irrelevant' WHERE story_id=$1", [story]);
    expect(await service.publicationMedia(story, settings)).toEqual([]);
  });

  it('excludes expired and superseded research attachments', async () => {
    const story = await id("INSERT INTO stories(status) VALUES('completed') RETURNING id"); stories.push(story);
    for (const [index, expired, superseded] of [[0, false, false], [1, true, false], [2, false, true]] as const) {
      const evidence = await id(`INSERT INTO evidence_documents(url,content_hash,content,access,metadata,expires_at)
        VALUES($1,$2,'Evidence','public',$3,now()+$4*interval '1 day') RETURNING id`,
      [`https://example.org/${index}`, `hash${index}`, JSON.stringify({ media: [{ type: 'image', url: `https://example.org/${index}.png` }] }), expired ? -1 : 1]);
      await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,superseded_at)
        VALUES($1,$2,'primary','relevant',CASE WHEN $3 THEN now() ELSE NULL END)`, [story, evidence, superseded]);
    }
    expect(await service.publicationMedia(story, settings)).toHaveLength(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
    expect(mocks.download.mock.calls[0]?.[0].url).toBe('https://example.org/0.png');
  });

  it('collects distinct URLs from every ancestor, including historical mention and supplement revisions', async () => {
    const oldest = await story(); const middle = await story(oldest); const latest = await story(middle);
    const oldMention = await report(oldest, 'old-mention', 'mention');
    const oldSupplement = await report(oldest, 'old-supplement', 'supplement');
    await retire(oldMention.item); await retire(oldSupplement.item);
    await report(middle, 'middle', 'mention');
    await report(latest, 'latest', 'mention');
    await report(latest, 'old-mention', 'supplement'); // Same repost URL, one download.
    const retiredLatest = await report(latest, 'retired-latest', 'mention'); await retire(retiredLatest.item);
    const unrelated = await story(); await report(unrelated, 'unrelated', 'mention');
    const evidence = await id(`INSERT INTO evidence_documents(url,content_hash,content,access,metadata,expires_at)
      VALUES('https://example.org/research','old-research','Research','public',$1,now()-interval '1 day') RETURNING id`,
    [JSON.stringify({ media: [{ type: 'video', url: 'https://example.org/ancestor-research.mp4' }] })]);
    await database.db.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance) VALUES($1,$2,'primary','relevant')", [oldest, evidence]);
    await database.db.query("UPDATE evidence_documents SET fetched_at=now()-interval '8 days' WHERE id=$1", [evidence]);
    const result = await service.publicationMedia(latest, settings);
    expect(result).toHaveLength(5);
    expect(mocks.download.mock.calls.map(([descriptor]) => descriptor.url).sort()).toEqual([
      'https://example.org/ancestor-research.mp4', 'https://example.org/latest.png', 'https://example.org/middle.png',
      'https://example.org/old-mention.png', 'https://example.org/old-supplement.png',
    ]);
  });

  it('does not reuse cached ancestor attachments after source access becomes private', async () => {
    vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
    const oldest = await story(); const latest = await story(oldest);
    const ancestor = await report(oldest, 'private-later', 'mention'); await retire(ancestor.item);
    expect(await service.publicationMedia(latest, settings)).toHaveLength(1);
    mocks.download.mockClear();
    await database.db.query("UPDATE sources SET access='restricted' WHERE id=$1", [ancestor.source]);
    await expect(service.publicationMedia(latest, settings)).rejects.toThrow('Private or unknown source access');
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('filters ineligible and failed ancestors but keeps attachments while their source rows are retained', async () => {
    const oldest = await story(); const latest = await story(oldest);
    const failed = await report(oldest, 'failed', 'mention');
    await database.db.query("UPDATE item_revisions SET metadata=metadata||'{\"pipelineFailure\":true}'::jsonb WHERE id=$1", [failed.revision]);
    const failedItem = await report(oldest, 'failed-item', 'supplement');
    await database.db.query("INSERT INTO operational_state(key,value) VALUES($1,'{}')", [`pipeline_failed_item:${failedItem.item}`]);
    const aged = await report(oldest, 'aged', 'mention');
    await database.db.query("UPDATE source_items SET collected_at=now()-interval '8 days' WHERE id=$1", [aged.item]);
    const ineligible = await report(oldest, 'ineligible', 'supplement');
    await database.db.query("UPDATE item_links SET metadata='{\"evidenceEligible\":false}'::jsonb WHERE revision_id=$1", [ineligible.revision]);
    const irrelevant = await report(oldest, 'irrelevant', 'supplement');
    await database.db.query("UPDATE story_link_sources SET classification='irrelevant' WHERE link_id IN(SELECT id FROM item_links WHERE revision_id=$1)", [irrelevant.revision]);
    await report(oldest, 'valid', 'mention');
    expect(await service.publicationMedia(latest, settings)).toHaveLength(2);
    expect(mocks.download.mock.calls.map(([descriptor]) => descriptor.url).sort()).toEqual([
      'https://example.org/aged.png', 'https://example.org/valid.png',
    ]);
  });

  it.each([null, 'test-same-v1'])('does not inherit attachments through an unverified or RELATED edge, classification %s', async version => {
    const discovery = await story(); await report(discovery, 'openai-php-discovery', 'mention');
    const outage = await story(discovery); await report(outage, 'alderon-outage', 'mention');
    await database.db.query('UPDATE story_publication_threads SET classification_version=$2 WHERE story_id=$1', [outage,version]);
    if (version) {
      const [lower, upper] = [discovery, outage].sort();
      await database.db.query(`INSERT INTO story_relations(lower_story_id,upper_story_id,relation,classifier_version)
        VALUES($1,$2,'related','test-v1')`, [lower,upper]);
    }
    expect(await service.publicationMedia(outage, settings)).toHaveLength(1);
    expect(mocks.download.mock.calls.map(([descriptor]) => descriptor.url)).toEqual(['https://example.org/alderon-outage.png']);
  });

});
