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
});
