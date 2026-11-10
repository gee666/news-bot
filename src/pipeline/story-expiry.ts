import { transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { publicationInputAdmission, publicationInputBoundary } from '../publishing/input-admission.js';
import { generationThread } from './generation-context.js';
import { unpublished } from './generation-store.js';

/** Stop automatic inference on stale drafts without deleting their attached reports or display. */
export async function expireStaleStoryWork(id: string, settings: AppSettings, batchId: string | null): Promise<boolean> {
  return transaction(async client => {
    const protectedStory = await client.query(`SELECT s.id FROM stories s WHERE s.id=$1 AND (
      NOT (${unpublished('s')})
      OR EXISTS(SELECT 1 FROM processing_batches p WHERE p.id=$2 AND p.manual_operation_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM processing_batches p WHERE p.manual_operation_id IS NOT NULL AND p.completed_at IS NULL AND (
        EXISTS(SELECT 1 FROM stage_state st WHERE st.batch_id=p.id AND st.story_id=s.id)
        OR EXISTS(SELECT 1 FROM story_mentions m JOIN batch_items b ON b.revision_id=m.revision_id
          WHERE b.batch_id=p.id AND m.story_id=s.id)
        OR EXISTS(SELECT 1 FROM story_link_sources sl JOIN item_links l ON l.id=sl.link_id
          JOIN batch_items b ON b.revision_id=l.revision_id WHERE b.batch_id=p.id AND sl.story_id=s.id))))`, [id, batchId]);
    if (protectedStory.rows.length) return false;
    const query = client.query.bind(client);
    const boundary = await publicationInputBoundary(id, query);
    const cutoff = Date.now() - settings.collectionWindowHours * 3_600_000;
    // Missing provenance needs repair, not an age-based terminal decision.
    if (!boundary.inputs.length || boundary.inputs.some(input => Date.parse(input.sourceTime) >= cutoff)) return false;
    const destinations = await query<{ destination_id: string }>(`${generationThread}
      SELECT DISTINCT p.destination_id FROM publications p
      LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
      LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
      WHERE coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) IN(SELECT id FROM generation_story_ids)
        AND p.message_id IS NOT NULL AND p.published_at IS NOT NULL`, [id]);
    for (const row of destinations.rows) {
      const admission = await publicationInputAdmission(id, row.destination_id, settings, query, { boundary });
      // A meaningful edit to previously published input can qualify by immutable revision time.
      if (admission.allowed || admission.reason === 'publication_input_unverifiable') return false;
    }
    await client.query(`UPDATE stage_state st SET status='skipped',next_retry_at=NULL,updated_at=now()
      FROM processing_batches p WHERE p.id=st.batch_id AND p.manual_operation_id IS NULL
        AND st.story_id=$1 AND st.status IN ('pending','running','waiting','failed')`, [id]);
    // A due outage marker would otherwise keep waking recovery for an expired draft.
    await client.query('DELETE FROM operational_state WHERE key=ANY($1::text[])',
      [[`digest_refresh:${id}`, `pipeline_failed_story:${id}`]]);
    return true;
  });
}
