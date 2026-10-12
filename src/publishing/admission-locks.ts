import type { PoolClient } from 'pg';
import { z } from 'zod';

/** Collector locks source items before invalidating stories. Keep that order at dispatch. */
async function lockInputs(client: Pick<PoolClient,'query'>, publicationId: string): Promise<string | null | undefined> {
  const identity = (await client.query<{ story_id: string | null; canonical_id: string | null }>(`
    SELECT p.story_id,coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) AS canonical_id FROM publications p
    LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    WHERE p.id=$1`,[publicationId])).rows[0];
  if (!identity) return undefined;
  const ids = [...new Set([identity.story_id,identity.canonical_id].filter((id): id is string=>id !== null))].sort();
  const items = await client.query<{ id: string }>(`SELECT i.id FROM source_items i WHERE EXISTS(SELECT 1 FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id
    WHERE r.item_id=i.id AND m.story_id=ANY($1::uuid[])) OR EXISTS(SELECT 1 FROM item_links l JOIN story_link_sources sl ON sl.link_id=l.id
    JOIN item_revisions r ON r.id=l.revision_id WHERE r.item_id=i.id AND sl.story_id=ANY($1::uuid[])) ORDER BY i.id FOR SHARE NOWAIT`,[ids]);
  await client.query(`SELECT src.id FROM sources src WHERE EXISTS(SELECT 1 FROM source_items i JOIN item_revisions r ON r.item_id=i.id
    JOIN story_mentions m ON m.revision_id=r.id WHERE i.source_id=src.id AND m.story_id=ANY($1::uuid[]))
    OR EXISTS(SELECT 1 FROM source_items i JOIN item_revisions r ON r.item_id=i.id JOIN item_links l ON l.revision_id=r.id
    JOIN story_link_sources sl ON sl.link_id=l.id WHERE i.source_id=src.id AND sl.story_id=ANY($1::uuid[])) ORDER BY src.id FOR SHARE NOWAIT`,[ids]);
  await client.query(`SELECT r.id FROM item_revisions r WHERE EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id=ANY($1::uuid[]))
    OR EXISTS(SELECT 1 FROM item_links l JOIN story_link_sources sl ON sl.link_id=l.id WHERE l.revision_id=r.id AND sl.story_id=ANY($1::uuid[])) ORDER BY r.id FOR SHARE NOWAIT`,[ids]);
  await client.query('SELECT id FROM stories WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',[ids]);
  const currentItems = await client.query<{ id: string }>(`SELECT i.id FROM source_items i WHERE EXISTS(SELECT 1 FROM item_revisions r JOIN story_mentions m ON m.revision_id=r.id
    WHERE r.item_id=i.id AND m.story_id=ANY($1::uuid[])) OR EXISTS(SELECT 1 FROM item_links l JOIN story_link_sources sl ON sl.link_id=l.id
    JOIN item_revisions r ON r.id=l.revision_id WHERE r.item_id=i.id AND sl.story_id=ANY($1::uuid[])) ORDER BY i.id`,[ids]);
  if (JSON.stringify(items.rows) !== JSON.stringify(currentItems.rows)) return undefined;
  await client.query('SELECT publication_id FROM story_publication_aliases WHERE publication_id=$1 FOR SHARE NOWAIT',[publicationId]);
  await client.query(`SELECT sm.merged_story_id FROM story_merges sm JOIN publications p ON p.story_id=sm.merged_story_id
    WHERE p.id=$1 FOR SHARE OF sm NOWAIT`,[publicationId]);
  await client.query('SELECT id FROM story_mentions WHERE story_id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT',[ids]);
  await client.query(`SELECT ml.mention_id FROM mention_links ml JOIN story_mentions m ON m.id=ml.mention_id
    WHERE m.story_id=ANY($1::uuid[]) ORDER BY ml.mention_id,ml.link_id FOR SHARE OF ml NOWAIT`,[ids]);
  await client.query('SELECT link_id FROM story_link_sources WHERE story_id=ANY($1::uuid[]) ORDER BY link_id FOR SHARE NOWAIT',[ids]);
  await client.query(`SELECT se.evidence_id FROM story_evidence se WHERE se.story_id=ANY($1::uuid[]) ORDER BY se.evidence_id FOR SHARE NOWAIT`,[ids]);
  await client.query(`SELECT e.id FROM evidence_documents e JOIN story_evidence se ON se.evidence_id=e.id
    WHERE se.story_id=ANY($1::uuid[]) ORDER BY e.id FOR SHARE OF e NOWAIT`,[ids]);
  await client.query("SELECT id FROM judgments WHERE story_id=ANY($1::uuid[]) AND stage='generation_research' ORDER BY id FOR SHARE NOWAIT",[ids]);
  return identity.canonical_id;
}

/** Association writers also touch stories. Refuse an active writer instead of inverting its row-lock order. */
export async function lockAdmissionInputs(client:Pick<PoolClient,'query'>,publicationId:string):Promise<string | null | undefined> {
  await client.query('SAVEPOINT publication_inputs');
  try {
    const result=await lockInputs(client,publicationId);
    await client.query('RELEASE SAVEPOINT publication_inputs');
    return result;
  } catch(error) {
    await client.query('ROLLBACK TO SAVEPOINT publication_inputs');
    await client.query('RELEASE SAVEPOINT publication_inputs');
    if(z.object({code:z.literal('55P03')}).safeParse(error).success) return undefined;
    throw error;
  }
}
