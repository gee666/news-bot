import type { PoolClient } from 'pg';
import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { automaticFailureHeld, collectedBoundarySchema, failureInputBoundary, failureInputsChanged } from '../pipeline/failure-admission.js';
import { generationIsCurrent } from '../pipeline/generation-freshness.js';
import { guardDigestEligibility } from '../pipeline/eligibility.js';
import { prepareDigest } from './store.js';
import { prepareUpdates } from './updates.js';

/** Manual ownership also covers unselected stories. General refresh cannot release a run's cap. */
export async function ownManualStories(client: PoolClient, ids: string[], runId: string, settings: AppSettings): Promise<void> {
  for (const id of ids) {
    const boundary = await failureInputBoundary(id, client.query.bind(client));
    await client.query(`INSERT INTO story_publication_ready(story_id,content_version,profile_version,model_version,manual_operation_id,status,manual_input_boundary)
      SELECT id,content_version,$2,$3,$4,'manual',$5 FROM stories WHERE id=$1
      ON CONFLICT(story_id) DO UPDATE SET manual_operation_id=EXCLUDED.manual_operation_id,status='manual',
        manual_input_boundary=EXCLUDED.manual_input_boundary,token=gen_random_uuid(),reason='manual_scope',ready_at=now()`,
    [id, settings.profileVersion, settings.modelVersion, runId, JSON.stringify(boundary)]);
  }
}

/** Runs in the completion transaction. No lease acquisition, Telegram I/O or model dispatch. */
export async function enqueueReadyStory(client: PoolClient, id: string, settings: AppSettings, batchId: string | null): Promise<void> {
  const manualId = batchId ? (await client.query<{ manual_operation_id: string | null }>(
    'SELECT manual_operation_id FROM processing_batches WHERE id=$1', [batchId])).rows[0]?.manual_operation_id ?? null : null;
  // Only a genuinely new automatic report can release previous manual ownership.
  let automaticInput = batchId ? (await client.query<{ fresh: boolean }>(`SELECT EXISTS(
    SELECT 1 FROM batch_items b JOIN processing_batches batch ON batch.id=b.batch_id
    JOIN item_revisions r ON r.id=b.revision_id JOIN source_items i ON i.current_revision_id=r.id
    JOIN story_mentions m ON m.revision_id=r.id AND m.story_id=$1
    WHERE b.batch_id=$2 AND batch.manual_operation_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM batch_items mb JOIN processing_batches manual ON manual.id=mb.batch_id
        JOIN item_revisions old ON old.id=mb.revision_id
        WHERE manual.manual_operation_id IS NOT NULL AND old.item_id=r.item_id AND old.normalized_text=r.normalized_text)
  ) AS fresh`, [id, batchId])).rows[0]?.fresh ?? false : false;
  let owner = (await client.query<{ manual_operation_id: string | null; manual_input_boundary: unknown }>(
    'SELECT manual_operation_id,manual_input_boundary FROM story_publication_ready WHERE story_id=$1', [id])).rows[0];
  if (!owner && !manualId && !automaticInput) {
    // Older retained manual scopes have no ready journal yet. Protect their unchanged
    // owned reports lazily, without backfilling publication events or regenerating output.
    const inherited = (await client.query<{ manual_operation_id: string }>(`SELECT manual.manual_operation_id
      FROM processing_batches manual JOIN batch_items mb ON mb.batch_id=manual.id
      JOIN item_revisions old ON old.id=mb.revision_id JOIN item_revisions current ON current.item_id=old.item_id
      JOIN source_items i ON i.current_revision_id=current.id JOIN story_mentions m ON m.revision_id=current.id
      WHERE manual.manual_operation_id IS NOT NULL AND m.story_id=$1 AND old.normalized_text=current.normalized_text
      ORDER BY manual.started_at DESC LIMIT 1`, [id])).rows[0];
    if (inherited) {
      await ownManualStories(client, [id], inherited.manual_operation_id, settings);
      owner = (await client.query<{ manual_operation_id: string | null; manual_input_boundary: unknown }>(
        'SELECT manual_operation_id,manual_input_boundary FROM story_publication_ready WHERE story_id=$1', [id])).rows[0];
    }
  }
  if (owner?.manual_operation_id && automaticInput) {
    const baseline = collectedBoundarySchema.safeParse(owner.manual_input_boundary);
    automaticInput = baseline.success && await failureInputsChanged(id, baseline.data, client.query.bind(client));
  }
  await client.query(`INSERT INTO story_publication_ready(story_id,content_version,profile_version,model_version,status,manual_operation_id)
    SELECT id,content_version,$2,$3,CASE WHEN $5::uuid IS NULL THEN 'pending' ELSE 'manual' END,$5 FROM stories WHERE id=$1 AND status='completed'
    ON CONFLICT(story_id) DO UPDATE SET content_version=EXCLUDED.content_version,profile_version=EXCLUDED.profile_version,
      model_version=EXCLUDED.model_version,token=gen_random_uuid(),ready_at=now(),reason=NULL,
      manual_operation_id=CASE WHEN $5::uuid IS NOT NULL THEN $5 WHEN $4 THEN NULL ELSE story_publication_ready.manual_operation_id END,
      status=CASE WHEN $5::uuid IS NOT NULL THEN 'manual'
        WHEN story_publication_ready.manual_operation_id IS NOT NULL AND NOT $4 THEN
          CASE WHEN EXISTS(SELECT 1 FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
            LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
            WHERE coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=$1 AND p.status='published')
            AND NOT EXISTS(SELECT 1 FROM operational_state op WHERE op.key='web_operation:'||story_publication_ready.manual_operation_id::text
              AND op.value->>'status' IN ('queued','running','waiting')) THEN 'pending' ELSE 'manual' END
        ELSE 'pending' END`,
  [id, settings.profileVersion, settings.modelVersion, automaticInput, manualId]);
}

const queuedSchema = z.object({ story_id: z.uuid(), token: z.uuid(), content_version: z.number().int(),
  profile_version: z.number().int(), model_version: z.number().int(), manual_operation_id: z.uuid().nullable() });

/** Caller owns only the publication lease, never the processor lease. Selection is journal-driven. */
export async function prepareReadyStories(settings: AppSettings, destinationId: string): Promise<void> {
  // Capture one fixed snapshot. Events arriving during selection wait for the next digest.
  const rows = z.array(queuedSchema).parse((await db.query(`SELECT story_id,token,content_version,profile_version,model_version,manual_operation_id
    FROM story_publication_ready q WHERE status='pending' OR (status='withheld' AND
      (reason='consolidation_unresolved' OR (reason='below_publication_score'
        AND EXISTS(SELECT 1 FROM stories s WHERE s.id=q.story_id AND s.interest_score>=$1))))
    ORDER BY ready_at,story_id`, [settings.minimumPublicationScore])).rows);
  for (const row of rows) {
    let reason: string | null = null;
    const current = (await db.query<{ status: string; content_version: number; profile_version: number | null; model_version: number | null; interest_score: number | null; interest_stale: boolean }>(
      'SELECT status,content_version,profile_version,model_version,interest_score,interest_stale FROM stories WHERE id=$1', [row.story_id])).rows[0];
    if (!current || current.status !== 'completed' || current.content_version !== row.content_version
      || current.profile_version !== row.profile_version || current.model_version !== row.model_version
      || settings.profileVersion !== row.profile_version || settings.modelVersion !== row.model_version) reason = 'not_current';
    else if (await automaticFailureHeld(row.story_id)) reason = 'failure_hold';
    else if ((current.interest_score ?? 0) < settings.minimumPublicationScore) reason = 'below_publication_score';
    else if (!await generationIsCurrent(row.story_id, settings)) reason = 'generation_not_current';
    if (!reason) {
      await guardDigestEligibility(settings, [row.story_id]);
      const eligible = (await db.query<{ interest_stale: boolean }>('SELECT interest_stale FROM stories WHERE id=$1', [row.story_id])).rows[0];
      if (!eligible || eligible.interest_stale) reason = 'eligibility_or_ranking_stale';
    }
    if (!reason && row.manual_operation_id) {
      const existing = await db.query(`SELECT 1 FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
        LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id WHERE p.destination_id=$1 AND p.status='published'
        AND coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=$2 LIMIT 1`, [destinationId, row.story_id]);
      if (!existing.rows.length) reason = 'manual_scope';
    }
    if (!reason) {
      if (!row.manual_operation_id) await prepareDigest(settings, destinationId, { storyIds: [row.story_id] });
      await prepareUpdates(settings, destinationId, [row.story_id]);
    }
    // A crash before acknowledgment safely repeats selection. Existing publication uniqueness and
    // immutable edit snapshots make that replay idempotent. Never acknowledge a newer ready event.
    await db.query(`UPDATE story_publication_ready SET status=$3,reason=$4 WHERE story_id=$1 AND token=$2
      AND manual_operation_id IS NOT DISTINCT FROM $5::uuid`, [row.story_id, row.token, reason ? 'withheld' : 'prepared', reason, row.manual_operation_id]);
  }
}
