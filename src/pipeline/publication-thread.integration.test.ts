import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '../settings.js';
import type { PublicationSnapshot } from '../types.js';

const url = process.env.TEST_DATABASE_URL;
const schema = `thread_${randomUUID().replaceAll('-', '')}`;
let admin: pg.Pool;
let database: typeof import('../db.js');
let settings: AppSettings;
async function one(sql: string, values: unknown[] = []): Promise<string> {
  const row = (await database.db.query<{ id: string }>(sql, values)).rows[0];
  if (!row) throw new Error('Missing fixture');
  return row.id;
}
async function story(previous?: string) {
  const id = await one(`INSERT INTO stories(status,headline,summary,interest_score,researched)
    VALUES('completed','Тема','Новые сведения',7,true) RETURNING id`);
  const source = await one(`INSERT INTO sources(connector_type,external_id,name,access)
    VALUES('telegram',$1,'Fixture','public') RETURNING id`, [randomUUID()]);
  const item = await one(`INSERT INTO source_items(source_id,external_id,original_url)
    VALUES($1,'1',$2) RETURNING id`, [source, `https://t.me/fixture/${id}`]);
  const revision = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
    VALUES($1,1,$2,'Report','Report') RETURNING id`, [item, id]);
  await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE id=$1', [item, revision]);
  const mention = await one(`INSERT INTO story_mentions(story_id,revision_id,text,ordinal,metadata)
    VALUES($1,$2,'Report',0,$3) RETURNING id`, [id, revision, JSON.stringify(previous ? { previous_story_id: previous } : {})]);
  return { id, revision, mention };
}
async function publish(id: string, message: string, earlier?: string, destination = '-100123') {
  const content: PublicationSnapshot = { headline: `Тема ${message}`, details: `Сведения ${message}`, score: 7,
    detailsKind: 'summary', sources: [], ...(earlier ? { earlier } : {}) };
  const snapshot = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id', [id, JSON.stringify(content)]);
  await database.db.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,status,message_id,published_at)
    VALUES($1,$2,$3,'published',$4::text,now()+$4::text::integer*interval '1 second')`, [id, snapshot, destination, message]);
}

describe.skipIf(!url)('published thread storage', () => {
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
  it('rebases drafts and reads every destination-specific ancestor without changing sent text', async () => {
    const { publishedThread, latestThreadStory, rebaseFollowup } = await import('./publication-thread.js');
    const first = await story(); await publish(first.id, '1');
    const second = await story(first.id); await publish(second.id, '2', 'Общая предыстория');
    await publish(first.id, '8', undefined, '-100456');
    const draft = await story(first.id);
    const sent = (await database.db.query('SELECT * FROM publications ORDER BY id')).rows;
    await rebaseFollowup(draft.id);
    expect(await latestThreadStory(first.id)).toBe(first.id);
    await database.db.query("UPDATE publications SET published_at=now()-interval '1 hour' WHERE destination_id='-100456'");
    await rebaseFollowup(draft.id);
    expect(await latestThreadStory(first.id)).toBe(second.id);
    const thread = await publishedThread(draft.id, database.db.query.bind(database.db), '-100123');
    expect(thread.map(post => post.storyId)).toEqual([first.id, second.id]);
    expect(thread[1]).toMatchObject({ details: 'Сведения 2', earlier: 'Общая предыстория' });
    const after = (await database.db.query('SELECT * FROM publications ORDER BY id')).rows;
    expect(after.map(row => row.snapshot_id)).toEqual(sent.map(row => row.snapshot_id));
    await database.db.query("DELETE FROM story_mentions WHERE story_id=$1", [draft.id]);
    expect((await publishedThread(draft.id, database.db.query.bind(database.db), '-100123')).map(post => post.storyId))
      .toEqual([first.id, second.id]);
  });
  it('loads full ancestor reports and evidence even when the short post omitted facts and the source revision retired', async () => {
    const first = await story(); await publish(first.id, '9');
    const draft = await story(first.id);
    const next = await one(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
      SELECT item_id,2,'next','Revised report','Revised report' FROM item_revisions WHERE id=$1 RETURNING id`, [first.revision]);
    await database.db.query('UPDATE source_items SET current_revision_id=$2 WHERE current_revision_id=$1', [first.revision, next]);
    const evidence = await one(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
      VALUES('https://author.org/details','Original announcement','A checker and its limitations were already announced.','public',now()-interval '1 hour') RETURNING id`);
    await database.db.query(`INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at)
      VALUES($1,$2,'primary','relevant',now())`, [first.id,evidence]);
    const { loadStory, loadPreviousEvidence, evidenceSnapshotHash } = await import('./generation-store.js');
    const input = await loadStory(draft.id);
    expect(input.mentions.map(mention => mention.id)).toEqual(expect.arrayContaining([first.mention,draft.mention]));
    expect(await loadPreviousEvidence(draft.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id:evidence,content:'A checker and its limitations were already announced.' }),
    ]));
    const before = await evidenceSnapshotHash(draft.id);
    await database.db.query("UPDATE evidence_documents SET content='Corrected announcement details.' WHERE id=$1", [evidence]);
    expect(await evidenceSnapshotHash(draft.id)).not.toBe(before);
  });
  it('cancels failed-story edits without touching unrelated pending edits', async () => {
    const target = await story(); await publish(target.id, '130');
    const unrelated = await story(); await publish(unrelated.id, '131');
    for (const id of [target.id, unrelated.id]) {
      const desired = await one('INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id',
        [id, JSON.stringify({ headline: 'Pending edit', details: 'Changed copy', detailsKind: 'summary', score: 7, sources: [] })]);
      await database.db.query('UPDATE publications SET pending_snapshot_id=$2 WHERE story_id=$1', [id, desired]);
      await database.db.query("UPDATE stories SET status='failed' WHERE id=$1", [id]);
    }
    const other = (await database.db.query('SELECT * FROM publications WHERE story_id=$1', [unrelated.id])).rows;
    await (await import('./story-failures.js')).prepareStoryFailureUpdates(settings, [target.id]);
    expect((await database.db.query('SELECT pending_snapshot_id FROM publications WHERE story_id=$1', [target.id])).rows)
      .toEqual([{ pending_snapshot_id: null }]);
    expect((await database.db.query('SELECT * FROM publications WHERE story_id=$1', [unrelated.id])).rows).toEqual(other);
  });
  it('keeps threads longer than twenty posts complete and stops corrupt cycles', async () => {
    const {publishedThread,latestThreadStory}=await import('./publication-thread.js');
    const ids:string[]=[];
    for (let index=0;index<22;index++) {
      const next=await story(ids.at(-1)); ids.push(next.id); await publish(next.id,String(index+20));
    }
    const last=ids.at(-1); const first=ids[0];
    if (!last || !first) throw new Error('Missing thread');
    expect((await publishedThread(last)).map(post=>post.storyId)).toEqual(ids);
    await database.db.query("UPDATE story_mentions SET metadata=jsonb_build_object('previous_story_id',$2::text) WHERE story_id=$1",[first,last]);
    expect((await publishedThread(last)).map(post=>post.storyId)).toEqual(ids);
    expect(await latestThreadStory(first)).toBe(last);
  }, 60_000);

});
