import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, transaction } from '../db.js';
import { publicationSnapshotSchema } from '../types.js';
import { render } from './render.js';
import { publicationSelect, snapshotFor, type Publication, type StoryContent } from './store.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `pub_${randomUUID().replaceAll('-','')}`;
let pool: pg.Pool;
let admin: pg.Pool;

describe.skipIf(!databaseUrl)('snapshot rendering after PostgreSQL history deletion', () => {
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
    await migrate(pool);
  });
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  it('copies sources and renders the full post after deleting items, mentions, evidence and story', async () => {
    const callbackId = randomUUID().replaceAll('-','');
    const storyId = await transaction(async client => {
      const story = (await client.query<StoryContent>(`INSERT INTO stories (status,headline,summary,interest_score,researched,profile_version,model_version)
        VALUES ('completed','Вышла модель <AI>',$1,8,true,1,1) RETURNING *`, ['Подробности & данные'])).rows[0];
      if (!story) throw new Error('Story missing');
      for (const [externalId,name,access,url] of [
        ['-10011','Открытый канал','public','https://t.me/public/1'],
        ['-10022','Закрытый канал','restricted','https://t.me/c/22/1'],
      ]) {
        const source = (await client.query<{ id: string }>(`INSERT INTO sources(connector_type,external_id,name,access)
          VALUES ('telegram',$1,$2,$3) RETURNING id`, [externalId,name,access])).rows[0];
        if (!source) throw new Error('Source missing');
        const item = (await client.query<{ id: string }>(`INSERT INTO source_items(source_id,external_id,original_url) VALUES ($1,'1',$2) RETURNING id`, [source.id,url])).rows[0];
        if (!item) throw new Error('Item missing');
        const revision = (await client.query<{ id: string }>(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
          VALUES ($1,1,'hash','raw','raw') RETURNING id`, [item.id])).rows[0];
        if (!revision) throw new Error('Revision missing');
        await client.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2', [revision.id,item.id]);
        const mention = (await client.query<{ id: string }>(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal)
          VALUES ($1,$2,'mention',0) RETURNING id`, [revision.id,story.id])).rows[0];
        if (!mention) throw new Error('Mention missing');
        const link = (await client.query<{ id: string }>(`INSERT INTO item_links(revision_id,url) VALUES ($1,'https://advert.org') RETURNING id`, [revision.id])).rows[0];
        if (!link) throw new Error('Link missing');
        await client.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES ($1,$2,'irrelevant')", [mention.id,link.id]);
        const withdrawnItem = (await client.query<{ id: string }>(`INSERT INTO source_items(source_id,external_id,original_url)
          VALUES ($1,'2',$2) RETURNING id`, [source.id,url?.replace('/1','/2')])).rows[0];
        if (!withdrawnItem) throw new Error('Withdrawn item missing');
        const oldRevision = (await client.query<{ id: string }>(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
          VALUES ($1,1,'old','old','old') RETURNING id`, [withdrawnItem.id])).rows[0];
        const currentRevision = (await client.query<{ id: string }>(`INSERT INTO item_revisions(item_id,revision_number,content_hash,original_text,normalized_text)
          VALUES ($1,2,'withdrawn','withdrawn','withdrawn') RETURNING id`, [withdrawnItem.id])).rows[0];
        if (!oldRevision || !currentRevision) throw new Error('Withdrawn revisions missing');
        await client.query('UPDATE source_items SET current_revision_id=$1 WHERE id=$2', [currentRevision.id,withdrawnItem.id]);
        const oldMention = (await client.query<{ id: string }>(`INSERT INTO story_mentions(revision_id,story_id,text,ordinal)
          VALUES ($1,$2,'withdrawn mention',0) RETURNING id`, [oldRevision.id,story.id])).rows[0];
        const oldLink = (await client.query<{ id: string }>(`INSERT INTO item_links(revision_id,url)
          VALUES ($1,'https://withdrawn.org') RETURNING id`, [oldRevision.id])).rows[0];
        if (!oldMention || !oldLink) throw new Error('Withdrawn link missing');
        await client.query("INSERT INTO mention_links(mention_id,link_id,classification) VALUES ($1,$2,'relevant')", [oldMention.id,oldLink.id]);
      }
      const evidence = (await client.query<{ id: string }>(`INSERT INTO evidence_documents(url,title,content,access,expires_at)
        VALUES ('https://author.org','Автор <AI>','Actual original author text','public',now() + interval '14 days') RETURNING id`)).rows[0];
      if (!evidence) throw new Error('Evidence missing');
      await client.query("INSERT INTO story_evidence(story_id,evidence_id,role,relevance,verified_at) VALUES ($1,$2,'primary','relevant',now())", [story.id,evidence.id]);
      const content = await snapshotFor(client,story);
      expect(content.sources.map(source => source.url)).toEqual(['https://author.org','https://t.me/c/22/1','https://t.me/public/1']);
      const snapshot = (await client.query<{ id: string }>(`INSERT INTO publication_snapshots(story_id,content) VALUES ($1,$2) RETURNING id`, [story.id,JSON.stringify(content)])).rows[0];
      if (!snapshot) throw new Error('Snapshot missing');
      await client.query(`INSERT INTO publications(story_id,snapshot_id,destination_id,message_id,callback_id,status,current_view,current_page)
        VALUES ($1,$2,'-10099','100',$3,'published','details',1)`, [story.id,snapshot.id,callbackId]);
      return story.id;
    },pool);
    await pool.query('DELETE FROM source_items');
    await pool.query('DELETE FROM evidence_documents');
    await pool.query('DELETE FROM stories WHERE id=$1', [storyId]);
    const publication = (await pool.query<Publication>(`${publicationSelect} WHERE p.callback_id=$1`, [callbackId])).rows[0];
    if (!publication) throw new Error('Publication missing');
    expect(publication.story_id).toBeNull();
    const snapshot = publicationSnapshotSchema.parse(publication.content);
    const message = render(snapshot);
    expect(message.reply_markup.inline_keyboard).toEqual([]);
    expect(message.text).toContain('Подробности &amp; данные');
    expect(message.text).toContain('Вышла модель &lt;AI&gt;');
    expect(message.text).toContain('доступ ограничен');
    expect(message.text).not.toContain('advert.org');
    expect(message.text.indexOf('author.org')).toBeLessThan(message.text.indexOf('t.me/'));
    expect(message.text).toContain('Интерес: 8/10');
  });
});
