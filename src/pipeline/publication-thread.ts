import { db, transaction } from '../db.js';
import { publicationSnapshotSchema, type PublicationSource } from '../types.js';
import { publicationThreadEdges } from './generation-context.js';

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
    WITH RECURSIVE ${publicationThreadEdges}, thread(id,path) AS (
      SELECT $1::uuid,ARRAY[$1::uuid]
      UNION ALL SELECT e.previous_story_id,t.path||e.previous_story_id FROM thread t
        JOIN publication_thread_edges e ON e.story_id=t.id WHERE NOT e.previous_story_id=ANY(t.path)
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
  const result = await query<{ story_id: string }>(`WITH RECURSIVE ${publicationThreadEdges}, down(id,path) AS (
      SELECT $1::uuid,ARRAY[$1::uuid]
      UNION ALL SELECT e.story_id,d.path||e.story_id FROM down d
        JOIN publication_thread_edges e ON e.previous_story_id=d.id WHERE NOT e.story_id=ANY(d.path)
    ) SELECT p.story_id FROM down JOIN publications p ON p.story_id=down.id WHERE ${published}
    ORDER BY p.published_at DESC,p.id DESC LIMIT 1`, [storyId]);
  return result.rows[0]?.story_id ?? storyId;
}

/** Points a draft follow-up at the newest post of its thread, which may have been sent after matching. */
export async function rebaseFollowup(storyId: string): Promise<boolean> {
  let changed = false;
  const links = await db.query<{ id: string }>(`WITH ${publicationThreadEdges}
    SELECT previous_story_id AS id FROM publication_thread_edges WHERE story_id=$1`, [storyId]);
  for (const { id } of links.rows) {
    const latest = await latestThreadStory(id);
    if (latest !== id && latest !== storyId) {
      await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
        const conflict = await client.query(`SELECT 1 FROM story_relations
          WHERE lower_story_id=least($1::uuid,$2::uuid) AND upper_story_id=greatest($1::uuid,$2::uuid)
            AND (relation<>'same' OR provenance->>'quarantined'='true')`, [storyId, latest]);
        if (conflict.rows.length) return;
        // An authorized reclassification may have quarantined this edge after the read.
        const stillVerified = await client.query(`WITH ${publicationThreadEdges}
          SELECT 1 FROM publication_thread_edges WHERE story_id=$1 AND previous_story_id=$2`, [storyId, id]);
        if (!stillVerified.rows.length) return;
        const updated = await client.query(`INSERT INTO story_publication_threads(story_id,previous_story_id,classification_version)
          VALUES($1,$2,'verified-rebase-v1') ON CONFLICT(story_id) DO UPDATE SET previous_story_id=EXCLUDED.previous_story_id,
            classification_version=EXCLUDED.classification_version
          WHERE story_publication_threads.previous_story_id IS DISTINCT FROM EXCLUDED.previous_story_id RETURNING story_id`,
        [storyId, latest]);
        await client.query(`UPDATE story_mentions
          SET metadata=jsonb_set(metadata,'{previous_story_id}',to_jsonb($3::text))
          WHERE story_id=$1 AND metadata->>'previous_story_id'=$2`, [storyId, id, latest]);
        changed ||= Boolean(updated.rows.length);
      });
    }
  }
  return changed;
}
