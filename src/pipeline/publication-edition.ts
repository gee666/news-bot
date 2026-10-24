import { transaction } from '../db.js';
import { latestThreadStory } from './publication-thread.js';
import { publicationThreadEdges } from './generation-context.js';
import { unpublished } from './generation-store.js';

/** A source-only enrichment creates a new edition, never a content edit of a sent post.
 * Move real reports rather than inventing extracted quotes. Durable thread edges keep
 * the sent edition's ancestry even when its last report moves to the draft. */
export async function forkPublishedRefresh(storyId: string): Promise<string | null> {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const queued = await client.query('SELECT key FROM operational_state WHERE key=$1 FOR UPDATE', [`digest_refresh:${storyId}`]);
    if (!queued.rows.length) return null;
    const latest = await latestThreadStory(storyId, client.query.bind(client));
    const sent = await client.query<{ id: string }>(`SELECT s.id FROM stories s WHERE s.id=$1
      AND NOT (${unpublished('s')}) FOR UPDATE`, [latest]);
    if (!sent.rows.length) return null;
    let draft = (await client.query<{ id: string }>(`WITH ${publicationThreadEdges} SELECT s.id FROM publication_thread_edges t
      JOIN stories s ON s.id=t.story_id WHERE t.previous_story_id=$1 AND ${unpublished('s')}
      AND s.status<>'rejected' AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      ORDER BY s.created_at,s.id LIMIT 1 FOR UPDATE OF s`, [latest])).rows[0]?.id;
    if (!draft) {
      const reports = await client.query(`SELECT m.id FROM story_mentions m JOIN source_items i ON i.current_revision_id=m.revision_id
        WHERE m.story_id=$1 ORDER BY m.id FOR UPDATE OF m FOR SHARE OF i`, [latest]);
      if (!reports.rows.length) return null;
      draft = (await client.query<{ id: string }>(`INSERT INTO stories(status,chosen_excerpt,meaningful_hash)
        SELECT 'processing',chosen_excerpt,meaningful_hash FROM stories WHERE id=$1 RETURNING id`, [latest])).rows[0]?.id;
      if (!draft) throw new Error('Could not create cumulative publication edition');
      await client.query("INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version) VALUES($1,$2,'source-copy-v1')", [draft, latest]);
      await client.query(`UPDATE story_mentions SET story_id=$2,metadata=metadata||jsonb_build_object('previous_story_id',$1::text)
        WHERE story_id=$1`, [latest, draft]);
    }
    await client.query(`INSERT INTO story_link_sources(link_id,story_id,classification,model_key,model_version,prompt_version,input_hash,assessed_at)
      SELECT DISTINCT ON(link_id) link_id,$2,classification,model_key,model_version,prompt_version,input_hash,assessed_at
      FROM story_link_sources WHERE story_id=ANY($1::uuid[])
      ORDER BY link_id,array_position(ARRAY['irrelevant','uncertain','relevant'],classification) DESC,assessed_at DESC
      ON CONFLICT(link_id,story_id) DO UPDATE SET classification=EXCLUDED.classification,model_key=EXCLUDED.model_key,
        model_version=EXCLUDED.model_version,prompt_version=EXCLUDED.prompt_version,input_hash=EXCLUDED.input_hash,assessed_at=EXCLUDED.assessed_at`,
    [[storyId, latest], draft]);
    await client.query(`UPDATE stories SET status='processing',interest_stale=true,content_version=content_version+1,
      headline=NULL,summary=NULL,translated_excerpt=NULL,researched=false,updated_at=now() WHERE id=$1`, [draft]);
    await client.query(`INSERT INTO operational_state(key,value) VALUES($1,jsonb_build_object('storyId',$2::text))
      ON CONFLICT(key) DO UPDATE SET updated_at=now()`, [`digest_refresh:${draft}`, draft]);
    await client.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${storyId}`]);
    return draft;
  });
}
