import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { generationClient, recordGenerationFailure, requireInferenceApproval } from './generation-model.js';

import { stage } from './state.js';
import { applyExtraction, committedExtraction, EXTRACTION_VERSION, eventsSchema } from './extraction-store.js';
import { extractEvents } from './extraction-model.js';
import { classifyItemLinks } from './source-links.js';
import { existingItemFailures, itemWork } from './item-failures.js';

export { validSpans } from './extraction-store.js';
const revisionSchema = z.object({ id: z.uuid(), original_text: z.string(), access: z.string() });
export async function extractBatch(batchId: string, settings: AppSettings,
  onExtracted?: (revisionId: string) => Promise<void>): Promise<void> {
  await db.query(`UPDATE batch_items b SET status='failed',disposition_reason='superseded_revision'
    FROM item_revisions r JOIN source_items i ON i.id=r.item_id
    WHERE b.batch_id=$1 AND b.revision_id=r.id AND i.current_revision_id IS DISTINCT FROM r.id
      AND b.status IN ('pending','processing')`, [batchId]);
  await db.query(`UPDATE stage_state s SET status='skipped',next_retry_at=NULL,updated_at=now()
    FROM item_revisions r JOIN source_items i ON i.id=r.item_id
    WHERE s.batch_id=$1 AND s.revision_id=r.id AND i.current_revision_id IS DISTINCT FROM r.id
      AND s.status IN ('pending','waiting','running')`, [batchId]);
  const result = await db.query(`SELECT r.id,r.original_text,s.access FROM batch_items b JOIN item_revisions r ON r.id=b.revision_id
    JOIN source_items i ON i.id=r.item_id JOIN sources s ON s.id=i.source_id WHERE b.batch_id=$1 AND i.current_revision_id=r.id
      AND b.disposition_reason IS DISTINCT FROM 'outside_collection_window'
    ORDER BY (b.status IN ('pending','processing')) DESC,
      (SELECT max(st.updated_at) FROM stage_state st WHERE st.batch_id=b.batch_id AND st.revision_id=r.id) ASC NULLS FIRST,
      i.collected_at DESC,b.created_at,r.id`, [batchId]);
  // Untouched inputs and siblings get a turn before a comparison that used the last slice.
  const failed = await existingItemFailures(batchId);
  for (const revision of z.array(revisionSchema).parse(result.rows)) {
    await itemWork(batchId, revision.id, failed, async () => {
      const committed = await committedExtraction(revision.id);
      if (committed !== null) await applyExtraction(batchId, revision.id, revision.original_text, committed);
      else await stage(batchId, { revisionId: revision.id }, `extract:${EXTRACTION_VERSION}`, settings, eventsSchema, async context => {
        await requireInferenceApproval([revision.access], context.id);
        const events = await extractEvents(revision.original_text, await generationClient(settings),
          { operationId: context.id, attempt: context.attempt }, recordGenerationFailure, settings.interestProfile);
        await applyExtraction(batchId, revision.id, revision.original_text, events);
        return events;
      });
      // Successful extraction is immutable, even when another task failed before the checkpoint.
      await db.query(`UPDATE stage_state SET status='skipped',next_retry_at=NULL,updated_at=now()
        WHERE batch_id=$1 AND revision_id=$2 AND status IN ('pending','waiting','running','failed')
          AND (stage='count' OR stage LIKE 'item_eligibility:%' OR stage LIKE 'extract:%' OR stage LIKE 'validate_split:%')`,
        [batchId,revision.id]);
      await stage(batchId, { revisionId: revision.id }, `links:${EXTRACTION_VERSION}`, settings, z.boolean(),
        async context => { await classifyItemLinks(revision.id, settings, context); return true; });
    });
    // Link classification is enrichment. Its retry must not strand committed news.
    if (onExtracted && await committedExtraction(revision.id) !== null) await onExtracted(revision.id);
  }
}
