import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { eventInput, type EventInput, type HistoricalEventRef } from './consolidation-input.js';
import { hash } from './state.js';

/** Prior ownership remains evidence when a collector edit retires its last current report. */
export async function historicalEventInput(id: string, ref: HistoricalEventRef,
  client: Pick<PoolClient,'query'> = db): Promise<EventInput | null> {
  if (await eventInput(id,client)) return null;
  const rows = await client.query<{ id:string; text:string; source_url:string|null; links:string[] }>(`
    SELECT m.id,m.text,i.original_url AS source_url,
      ARRAY(SELECT DISTINCT l.url FROM mention_links ml JOIN item_links l ON l.id=ml.link_id
        WHERE ml.mention_id=m.id AND ml.classification='relevant' ORDER BY l.url) AS links
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.id=r.item_id
    WHERE m.story_id=$1 AND r.id=$2 ORDER BY m.id`, [id,ref.revisionId]);
  if (rows.rows.length) {
    const reports=rows.rows.map(row=>({text:row.text,sourceUrl:row.source_url,links:row.links}));
    const text=[...new Set(reports.map(report=>report.text))].join('\n\n');
    if (text!==ref.text) return null;
    return {id,text,reports,fingerprint:hash({history:ref.revisionId,reports})};
  }
  const affected = await client.query<{ source_url:string|null }>(`SELECT i.original_url AS source_url FROM stage_state s
    JOIN item_revisions r ON r.id=$3 JOIN source_items i ON i.id=r.item_id
    WHERE s.batch_id=$2 AND s.story_id=$1 AND s.stage='extraction_affected'
      AND s.output->>'revisionId'=$3::text AND s.output->>'previousText'=$4`, [id,ref.batchId,ref.revisionId,ref.text]);
  if (!affected.rows.length) return null;
  const reports=[{text:ref.text,sourceUrl:affected.rows[0]?.source_url ?? null,links:[]}];
  return {id,text:ref.text,reports,fingerprint:hash({history:ref,reports})};
}
