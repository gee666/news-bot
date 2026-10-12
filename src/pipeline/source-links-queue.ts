import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { hash } from './state.js';
import { sourceLinksFingerprintSql } from './source-links-deferrals.js';

const messageSchema = z.object({ revision_id: z.uuid(), original_text: z.string(), processing_key: z.string() });
export type SourceMessage = z.infer<typeof messageSchema>;

/** Catalogue changes invalidate completed messages; unchanged work never monopolizes the next batch. */
export async function pendingSourceMessages(settings: AppSettings, promptVersion: string,
  limits: { maxMessages: number }, batchId?: string): Promise<SourceMessage[]> {
  const catalogue = await db.query(`SELECT md5(coalesce(string_agg(
    s.id::text||s.content_version::text||m.id::text||md5(m.text),'' ORDER BY m.id),'')) AS fingerprint
    FROM stories s JOIN story_mentions m ON m.story_id=s.id
    JOIN source_items i ON i.current_revision_id=m.revision_id
    WHERE s.status<>'rejected' AND i.retention_at>=now()-$1*interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)`, [settings.retentionDays]);
  const fingerprint = z.object({ fingerprint: z.string() }).parse(catalogue.rows[0]).fingerprint;
  const key = hash({ fingerprint, promptVersion, model: [settings.jevUrl,settings.jevModel,settings.modelVersion,settings.piProvider,settings.piModel],
    candidateLimit: settings.matchCandidateLimit, retentionDays: settings.retentionDays });
  const rows = await db.query(`WITH pending AS (
    SELECT r.id AS revision_id,r.original_text,md5($3||r.original_text||coalesce((
      SELECT string_agg(l.id::text||l.url||coalesce(l.anchor_text,''),'' ORDER BY l.id)
      FROM item_links l WHERE l.revision_id=r.id),'')) AS processing_key,i.retention_at
    FROM item_revisions r JOIN source_items i ON i.current_revision_id=r.id JOIN sources so ON so.id=i.source_id
    WHERE so.active AND so.enabled AND i.retention_at>=now()-$1*interval '1 day'
      AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM batch_items b WHERE b.batch_id=$4 AND b.revision_id=r.id AND b.status<>'failed'))
      AND ($4::uuid IS NOT NULL OR NOT EXISTS(SELECT 1 FROM batch_items b JOIN processing_batches batch ON batch.id=b.batch_id
        WHERE b.revision_id=r.id AND batch.completed_at IS NULL AND batch.manual_operation_id IS NOT NULL))
      AND NOT EXISTS(SELECT 1 FROM operational_state failed WHERE failed.key='pipeline_failed_item:'||i.id::text)
      AND NOT EXISTS(SELECT 1 FROM operational_state failed WHERE failed.key LIKE 'source_link_deferred:%'
        AND failed.value->>'status'='unresolved' AND failed.value->>'phase'='role' AND failed.value->>'storyId' IS NULL
        AND failed.value->'scope'->>'itemId'=r.item_id::text
        AND failed.value->'scope'->>'textHash'=encode(sha256(convert_to(r.original_text,'UTF8')),'hex')
        AND failed.value->'scope'->>'linksHash'=${sourceLinksFingerprintSql}
        AND ((failed.value->>'attempts')::int >= $5 OR failed.value->>'next' IS NULL
          OR (failed.value->>'next')::timestamptz>now()))
      AND EXISTS(SELECT 1 FROM item_links l WHERE l.revision_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id)
  ) SELECT p.revision_id,p.original_text,p.processing_key FROM pending p
    LEFT JOIN source_link_processing done ON done.revision_id=p.revision_id
    WHERE done.processing_key IS DISTINCT FROM p.processing_key OR EXISTS(SELECT 1 FROM operational_state retry
      WHERE retry.key LIKE 'source_link_deferred:%' AND retry.value->>'status'='unresolved'
        AND retry.value->'scope'->>'revisionId'=p.revision_id::text
        AND (retry.value->>'attempts')::int<$5 AND (retry.value->>'next')::timestamptz<=now())
    ORDER BY done.processed_at ASC NULLS FIRST,p.retention_at,p.revision_id LIMIT $2`,
  [settings.retentionDays,limits.maxMessages,key,batchId ?? null,settings.requestMaxAttempts]);
  return z.array(messageSchema).parse(rows.rows);
}

export async function completeSourceMessage(message: SourceMessage, role: 'source_only' | 'excluded' | 'other') {
  await db.query(`INSERT INTO source_link_processing(revision_id,processing_key,role)
    VALUES($1,$2,$3) ON CONFLICT(revision_id) DO UPDATE SET processing_key=EXCLUDED.processing_key,
    role=EXCLUDED.role,processed_at=now()`, [message.revision_id,message.processing_key,role]);
}
