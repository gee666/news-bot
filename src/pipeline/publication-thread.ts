import { z } from 'zod';
import { db, transaction } from '../db.js';
import { publicationSnapshotSchema, type PublicationSource } from '../types.js';

/** A sent post in a follow-up thread, as readers saw it. */
export interface ThreadPost {
  storyId: string; headline: string; details: string; earlier?: string;
  destinationId: string; messageId: string; sources: PublicationSource[];
}

const published = `p.message_id IS NOT NULL AND p.published_at IS NOT NULL`;

/**
 * The story and its published ancestors through `previous_story_id` links, oldest first.
 * An unpublished draft contributes nothing itself. Visited IDs stop corrupt cycles without truncating long threads.
 */
export async function publishedThread(storyId: string, query = db.query.bind(db), destinationId?: string): Promise<ThreadPost[]> {
  const result = await query<{ story_id: string; content: unknown; destination_id: string; message_id: string }>(`
    WITH RECURSIVE thread(id,path) AS (
      SELECT $1::uuid,ARRAY[$1::uuid]
      UNION SELECT (m.metadata->>'previous_story_id')::uuid,t.path||(m.metadata->>'previous_story_id')::uuid FROM thread t
        JOIN story_mentions m ON m.story_id=t.id AND m.metadata ? 'previous_story_id'
        WHERE NOT (m.metadata->>'previous_story_id')::uuid=ANY(t.path)
    ) SELECT p.story_id,snap.content,p.destination_id,p.message_id
    FROM publications p JOIN publication_snapshots snap ON snap.id=p.snapshot_id
    WHERE p.story_id IN(SELECT id FROM thread) AND ${published} AND ($2::text IS NULL OR p.destination_id=$2)
    ORDER BY p.published_at,p.id`, [storyId, destinationId ?? null]);
  return result.rows.map(row => {
    const snapshot = publicationSnapshotSchema.parse(row.content);
    return { storyId: row.story_id, headline: snapshot.headline, details: snapshot.details,
      ...(snapshot.earlier ? { earlier: snapshot.earlier } : {}),
      destinationId: row.destination_id, messageId: row.message_id, sources: snapshot.sources };
  }).filter((post, index, posts) => posts.findIndex(other => other.storyId === post.storyId) === index);
}

/** The newest published post that continues the given published story. */
export async function latestThreadStory(storyId: string, query = db.query.bind(db)): Promise<string> {
  const result = await query<{ story_id: string }>(`WITH RECURSIVE down(id,path) AS (
      SELECT $1::uuid,ARRAY[$1::uuid]
      UNION SELECT m.story_id,d.path||m.story_id FROM down d JOIN story_mentions m ON m.metadata->>'previous_story_id'=d.id::text
        WHERE m.story_id IS NOT NULL AND NOT m.story_id=ANY(d.path)
    ) SELECT p.story_id FROM down JOIN publications p ON p.story_id=down.id WHERE ${published}
    ORDER BY p.published_at DESC,p.id DESC LIMIT 1`, [storyId]);
  return result.rows[0]?.story_id ?? storyId;
}

/** Points a draft follow-up at the newest post of its thread, which may have been sent after matching. */
export async function rebaseFollowup(storyId: string): Promise<boolean> {
  let changed = false;
  const links = await db.query<{ id: string }>(`SELECT DISTINCT metadata->>'previous_story_id' AS id FROM story_mentions
    WHERE story_id=$1 AND metadata ? 'previous_story_id'`, [storyId]);
  for (const { id } of links.rows) {
    const latest = await latestThreadStory(id);
    if (latest !== id && latest !== storyId) {
      const updated = await db.query(`UPDATE story_mentions
        SET metadata=jsonb_set(metadata,'{previous_story_id}',to_jsonb($3::text))
        WHERE story_id=$1 AND metadata->>'previous_story_id'=$2`, [storyId, id, latest]);
      changed ||= Boolean(updated.rowCount);
    }
  }
  return changed;
}

/** Everything readers already know. A combined post already summarizes its predecessors. */
export function threadKnowledge(posts: readonly ThreadPost[]): string {
  let start = 0;
  posts.forEach((post, index) => { if (post.earlier) start = index; });
  const first = posts[start];
  return [...(first?.earlier ? [first.earlier] : []), ...posts.slice(start).map(post => post.details)]
    .filter(text => text.trim()).join('\n\n');
}

/**
 * Moves a draft without new information into the published story it repeats.
 * The published text stays unchanged; only its source list can grow.
 */
export async function absorbIntoPublished(draftId: string, targetId: string, primarySourceUrls: readonly string[]): Promise<boolean> {
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const locked = await client.query(`SELECT id FROM stories WHERE id=ANY($1::uuid[]) AND status<>'rejected'
      AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=stories.id) ORDER BY id FOR UPDATE`, [[draftId, targetId]]);
    if (locked.rows.length !== 2) return false;
    const target = await client.query(`SELECT 1 FROM publications p WHERE p.story_id=$1 AND ${published}`, [targetId]);
    const draft = await client.query(`SELECT 1 FROM publications p WHERE p.story_id=$1 AND ${published}`, [draftId]);
    if (!target.rows.length || draft.rows.length) return false;
    await client.query(`INSERT INTO story_evidence(story_id,evidence_id,role,assessment,verified_at,relevance,assessed_at,superseded_at)
      SELECT $1,evidence_id,role,assessment,verified_at,relevance,assessed_at,superseded_at FROM story_evidence WHERE story_id=$2
      ON CONFLICT(story_id,evidence_id) DO NOTHING`, [targetId, draftId]);
    await client.query('DELETE FROM story_evidence WHERE story_id=$1', [draftId]);
    await client.query(`INSERT INTO story_link_sources
      (link_id,story_id,classification,model_key,model_version,prompt_version,input_hash,assessed_at)
      SELECT link_id,$1,classification,model_key,model_version,prompt_version,input_hash,assessed_at
      FROM story_link_sources WHERE story_id=$2 ON CONFLICT(link_id,story_id) DO NOTHING`, [targetId, draftId]);
    await client.query('DELETE FROM story_link_sources WHERE story_id=$1', [draftId]);
    // The moved mentions keep the draft's origin classification for the target's source list.
    await client.query(`UPDATE story_mentions SET story_id=$1,metadata=(metadata-'previous_story_id')
      || jsonb_build_object('relation','same','absorbedFromStoryId',$2::text,'primary_source_urls',$3::jsonb) WHERE story_id=$2`,
    [targetId, draftId, JSON.stringify(z.array(z.url()).parse([...primarySourceUrls]))]);
    await client.query(`INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,'same')`, [draftId, targetId]);
    await client.query(`UPDATE stories SET status='rejected',updated_at=now() WHERE id=$1`, [draftId]);
    await client.query('DELETE FROM embeddings WHERE story_id=$1', [draftId]);
    await client.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${draftId}`]);
    return true;
  });
}
