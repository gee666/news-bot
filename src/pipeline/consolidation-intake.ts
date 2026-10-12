import { z } from 'zod';
import { db, transaction } from '../db.js';
import { evidenceLinkSql } from '../sources/link-policy.js';
import { eventInput, eventDecisionInput, eventSemanticHash } from './consolidation-input.js';
import { hash } from './state.js';

const intakeSchema = z.object({
  revision_id: z.uuid(), item_id: z.uuid(), text_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  urls: z.array(z.url()), novel: z.boolean(),
});
export type ConsolidationIntake = z.infer<typeof intakeSchema>;
type Query = typeof db.query;

/** Global revision receipts survive story moves, extraction replacement and policy/cache changes. */
export async function pendingConsolidationIntake(options: { batchId?: string; retentionDays?: number; revisionIds?: readonly string[] } = {},
  query: Query = db.query.bind(db)): Promise<ConsolidationIntake[]> {
  const result = await query(`WITH pending AS (
    SELECT r.id AS revision_id,r.item_id,encode(sha256(convert_to(r.original_text,'UTF8')),'hex') AS text_fingerprint,
      ARRAY(SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=r.id AND l.url ~ '^https?://' ORDER BY l.url) AS urls,
      ARRAY(SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=r.id AND l.url ~ '^https?://' AND ${evidenceLinkSql} ORDER BY l.url) AS meaningful_urls,
      NOT EXISTS(SELECT 1 FROM batch_items b WHERE b.revision_id=r.id AND b.status='rejected') AS admissible
    FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id
    WHERE NOT EXISTS(SELECT 1 FROM consolidation_intake done WHERE done.revision_id=r.id)
      AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM batch_items b WHERE b.batch_id=$1 AND b.revision_id=r.id AND b.status<>'failed'))
      AND ($2::integer IS NULL OR i.retention_at>=now()-$2*interval '1 day')
      AND ($3::uuid[] IS NULL OR r.id=ANY($3))
      AND ($1::uuid IS NOT NULL OR $3::uuid[] IS NOT NULL OR NOT EXISTS(
        SELECT 1 FROM batch_items b JOIN processing_batches batch ON batch.id=b.batch_id
        WHERE b.revision_id=r.id AND batch.completed_at IS NULL AND batch.manual_operation_id IS NOT NULL))
      AND r.normalized_text ~ '\\S' AND jsonb_typeof(r.metadata)='object'
      AND (NOT (r.metadata ? 'pipelineFailure') OR r.metadata->'pipelineFailure'='false'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)
      AND ((NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id IS NULL)
        AND (r.metadata ? 'pipelineExtractionVersion' OR EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id IS NOT NULL)))
        OR EXISTS(SELECT 1 FROM batch_items b JOIN processing_batches batch ON batch.id=b.batch_id
          WHERE b.revision_id=r.id AND (b.status='rejected' OR batch.status='completed')))
  ) SELECT revision_id,item_id,text_fingerprint,urls,
    admissible AND (NOT EXISTS(SELECT 1 FROM consolidation_intake old WHERE old.item_id=p.item_id AND old.text_fingerprint=p.text_fingerprint)
      OR EXISTS(SELECT 1 FROM unnest(p.meaningful_urls) u(url) WHERE NOT EXISTS(
        SELECT 1 FROM consolidation_intake old WHERE old.item_id=p.item_id AND u.url=ANY(old.urls)))) AS novel
    FROM pending p ORDER BY revision_id`, [options.batchId ?? null, options.retentionDays ?? null, options.revisionIds ?? null]);
  return z.array(intakeSchema).parse(result.rows);
}

/** Recheck admission under the merge's source locks, not just the classifier input fingerprints. */
export async function mergeHasIntake(storyIds: string[], captured: readonly ConsolidationIntake[] | undefined,
  query: Query): Promise<boolean> {
  const pending = (await pendingConsolidationIntake(captured ? { revisionIds: captured.map(row => row.revision_id) } : {}, query)).filter(row => row.novel
    && (captured === undefined || captured.some(prior => prior.revision_id === row.revision_id
      && prior.item_id === row.item_id && prior.text_fingerprint === row.text_fingerprint
      && JSON.stringify(prior.urls) === JSON.stringify(row.urls))));
  if (!pending.length) return false;
  const owners = await query<{ story_id: string }>(`SELECT DISTINCT m.story_id FROM story_mentions m
    JOIN source_items i ON i.current_revision_id=m.revision_id
    WHERE m.story_id=ANY($1::uuid[]) AND m.revision_id=ANY($2::uuid[])`, [storyIds, pending.map(row => row.revision_id)]);
  return owners.rows.length>0;
}

/** Only a successfully drained pass consumes its snapshots. Interrupted passes remain resumable. */
export async function completeConsolidationIntake(captured: readonly ConsolidationIntake[]): Promise<void> {
  if (!captured.length) return;
  await transaction(async client => {
    const held = await client.query<{ value: unknown }>(`SELECT value FROM operational_state
      WHERE key LIKE 'consolidation_deferred:%' AND value->>'status'='unresolved'`);
    const heldStories = new Set<string>();
    for (const row of held.rows) {
      const pair = z.object({ leftId: z.uuid(),rightId: z.uuid(),inputHash: z.string(),semanticHash: z.string().optional() }).parse(row.value);
      const left = await eventInput(pair.leftId,client); const right = await eventInput(pair.rightId,client);
      if (left && right && (pair.semanticHash ? eventSemanticHash(left,right)===pair.semanticHash : hash(eventDecisionInput(left,right))===pair.inputHash)) {
        heldStories.add(left.id); heldStories.add(right.id);
      }
    }
    const owned = await client.query<{ revision_id: string }>(`SELECT DISTINCT m.revision_id FROM story_mentions m
      JOIN source_items i ON i.current_revision_id=m.revision_id WHERE m.story_id=ANY($1::uuid[])`, [[...heldStories]]);
    const blocked = new Set(owned.rows.map(row => row.revision_id));
    const admitted = captured.filter(row => !blocked.has(row.revision_id));
    if (!admitted.length) return;
    await client.query('SELECT id FROM source_items WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
      [[...new Set(admitted.map(row => row.item_id))]]);
    // A new current revision may have arrived during the pass. Acknowledge only the exact bytes visited,
    // including retired snapshots, never the replacement revision or a mutated payload.
    await client.query(`INSERT INTO consolidation_intake(revision_id,item_id,text_fingerprint,urls)
      SELECT r.id,r.item_id,c.text_fingerprint,c.urls FROM jsonb_to_recordset($1::jsonb)
        AS c(revision_id uuid,item_id uuid,text_fingerprint text,urls text[])
      JOIN item_revisions r ON r.id=c.revision_id AND r.item_id=c.item_id
      WHERE encode(sha256(convert_to(r.original_text,'UTF8')),'hex')=c.text_fingerprint
        AND NOT EXISTS(SELECT 1 FROM operational_state deferred WHERE deferred.key LIKE 'consolidation_deferred:%'
          AND deferred.value->>'status'='unresolved'
          AND deferred.value->'intake' @> jsonb_build_array(jsonb_build_object('revision_id',r.id)))
        AND ARRAY(SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=r.id AND l.url ~ '^https?://' ORDER BY l.url)=c.urls
      ON CONFLICT(revision_id) DO NOTHING`, [JSON.stringify(admitted)]);
  });
}
