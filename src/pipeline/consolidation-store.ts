import { db, transaction } from '../db.js';
import { eventInput, type EventInput } from './consolidation-input.js';
import { hash } from './state.js';
import { mergeHasIntake, type ConsolidationIntake } from './consolidation-intake.js';

export type EventRelation = 'same' | 'update';
export interface MergeResult { canonicalId: string; mergedId: string }

/** A merge needs actual unconsumed intake as well as unchanged classifier inputs. */
export async function mergeStories(left: EventInput, right: EventInput, relation: EventRelation,
  intake?: readonly ConsolidationIntake[]): Promise<MergeResult | null> {
  if (left.id === right.id) return null;
  return transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    // Collector edits must not change current_revision_id between fingerprint check and commit.
    await client.query(`SELECT i.id FROM source_items i WHERE EXISTS(SELECT 1 FROM item_revisions r
      JOIN story_mentions m ON m.revision_id=r.id WHERE r.item_id=i.id AND m.story_id=ANY($1::uuid[]))
      ORDER BY i.id FOR SHARE`, [[left.id, right.id]]);
    const locked = await client.query<{ id: string }>(`SELECT id FROM stories WHERE id=ANY($1::uuid[])
      AND status<>'rejected' AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=stories.id)
      ORDER BY id FOR UPDATE`, [[left.id, right.id]]);
    if (locked.rows.length !== 2) return null;
    const currentLeft = await eventInput(left.id, client);
    const currentRight = await eventInput(right.id, client);
    if (currentLeft?.fingerprint !== left.fingerprint || currentRight?.fingerprint !== right.fingerprint
      || !await mergeHasIntake([left.id, right.id], intake, client.query.bind(client))) return null;
    const order = await client.query<{ id: string }>(`SELECT s.id FROM stories s
      LEFT JOIN LATERAL (SELECT min(published_at) AS first_publication FROM publications
        WHERE story_id=s.id AND message_id IS NOT NULL AND published_at IS NOT NULL) p ON true
      WHERE s.id=ANY($1::uuid[]) ORDER BY p.first_publication ASC NULLS LAST,s.created_at,s.id`, [[left.id, right.id]]);
    const canonicalId = order.rows[0]?.id;
    const mergedId = order.rows[1]?.id;
    if (!canonicalId || !mergedId) return null;
    await client.query(`INSERT INTO story_merge_evidence(merged_story_id,canonical_story_id,evidence_id,role,assessment,verified_at,relevance,assessed_at)
      SELECT story_id,$1,evidence_id,role,assessment,verified_at,relevance,assessed_at FROM story_evidence WHERE story_id=ANY($2::uuid[])
      ON CONFLICT(merged_story_id,evidence_id) DO NOTHING`, [canonicalId, [canonicalId, mergedId]]);
    await client.query('UPDATE story_merge_evidence SET canonical_story_id=$1 WHERE canonical_story_id=$2', [canonicalId, mergedId]);
    await client.query(`INSERT INTO story_evidence(story_id,evidence_id,role,assessment,verified_at,relevance,assessed_at,superseded_at)
      SELECT $1,evidence_id,role,assessment,verified_at,relevance,assessed_at,superseded_at FROM story_evidence WHERE story_id=$2
      ON CONFLICT(story_id,evidence_id) DO NOTHING`, [canonicalId, mergedId]);
    await client.query('DELETE FROM story_evidence WHERE story_id=$1', [mergedId]);
    await client.query(`INSERT INTO story_link_sources
      (link_id,story_id,classification,model_key,model_version,prompt_version,input_hash,assessed_at)
      SELECT link_id,$1,classification,model_key,model_version,prompt_version,input_hash,assessed_at
      FROM story_link_sources WHERE story_id=$2
      ON CONFLICT(link_id,story_id) DO UPDATE SET classification=EXCLUDED.classification,
        model_key=EXCLUDED.model_key,model_version=EXCLUDED.model_version,prompt_version=EXCLUDED.prompt_version,
        input_hash=EXCLUDED.input_hash,assessed_at=EXCLUDED.assessed_at
      WHERE array_position(ARRAY['irrelevant','uncertain','relevant'],EXCLUDED.classification) >
        array_position(ARRAY['irrelevant','uncertain','relevant'],story_link_sources.classification)`, [canonicalId, mergedId]);
    await client.query('DELETE FROM story_link_sources WHERE story_id=$1', [mergedId]);
    await client.query(`UPDATE story_mentions SET story_id=$1,
      metadata=metadata || jsonb_build_object('mergedFromStoryId',$2::text) WHERE story_id=$2`, [canonicalId, mergedId]);
    await client.query(`INSERT INTO story_merges(merged_story_id,canonical_story_id,relation) VALUES($1,$2,$3)`, [mergedId, canonicalId, relation]);
    await client.query('UPDATE story_merges SET canonical_story_id=$1 WHERE canonical_story_id=$2', [canonicalId, mergedId]);
    await client.query(`INSERT INTO story_publication_aliases(publication_id,original_story_id,canonical_story_id)
      SELECT id,story_id,$1 FROM publications WHERE story_id=ANY($2::uuid[])
      ON CONFLICT(publication_id) DO UPDATE SET canonical_story_id=EXCLUDED.canonical_story_id`, [canonicalId, [canonicalId, mergedId]]);
    await client.query('UPDATE story_publication_aliases SET canonical_story_id=$1 WHERE canonical_story_id=$2', [canonicalId, mergedId]);
    const combined = await eventInput(canonicalId, client);
    await client.query(`UPDATE stories SET status='processing',content_version=content_version+1,
      meaningful_hash=$2,headline=NULL,summary=NULL,translated_excerpt=NULL,researched=false,interest_stale=true,updated_at=now()
      WHERE id=$1`, [canonicalId, hash(combined?.fingerprint)]);
    await client.query(`UPDATE stories SET status='rejected',interest_stale=true,updated_at=now() WHERE id=$1`, [mergedId]);
    await client.query('DELETE FROM embeddings WHERE story_id=ANY($1::uuid[])', [[canonicalId, mergedId]]);
    await client.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${mergedId}`]);
    await client.query(`INSERT INTO operational_state(key,value) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
    [`digest_refresh:${canonicalId}`, JSON.stringify({ storyId: canonicalId })]);
    return { canonicalId, mergedId };
  });
}

export async function canonicalStoryId(id: string): Promise<string> {
  const result = await db.query<{ canonical_story_id: string }>('SELECT canonical_story_id FROM story_merges WHERE merged_story_id=$1', [id]);
  return result.rows[0]?.canonical_story_id ?? id;
}
