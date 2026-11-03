import type { PoolClient } from 'pg';
import type { AppSettings } from '../settings.js';
import type { Publication } from './store.js';
import { settleEdit } from './edit-settlement.js';
import { releaseDestination } from './destination-order.js';
import { publicationInputAdmission, preparedPublicationInputs, type InputAdmission } from './input-admission.js';

export interface DeliveryAuthorization { verificationTest?: boolean }
type Operation = 'send' | 'edit';
type Reason = 'publishing_paused' | 'snapshot_changed' | 'story_ineligible' | 'settings_changed' | 'delivery_outcome_unknown'
  | Extract<InputAdmission, { allowed: false }>['reason'];
export type PublicationAdmission = { allowed: true } | { allowed: false; reason: Reason };

/** Dispatch compares persisted identity and preparation versions, never rebuilds story content. */
export async function publicationAdmission(client: Pick<PoolClient, 'query'>, publication: Publication, settings: AppSettings,
  operation: Operation, authorization: DeliveryAuthorization = {}, botId: string | null = publication.bot_id): Promise<PublicationAdmission> {
  const row = (await client.query<{ reason: Reason | null; story_id: string | null;
    collection_window_hours: number }>(`SELECT CASE
    WHEN coalesce((settings.value->>'publishingEnabled')::boolean,false) IS NOT TRUE THEN 'publishing_paused'
    WHEN target.value->>'channelId' IS DISTINCT FROM p.destination_id
      OR p.bot_id IS DISTINCT FROM $5::text
      OR coalesce(verified.value->>'destinationId',test.value->>'destinationId') IS DISTINCT FROM p.destination_id
      OR coalesce(verified.value->>'botId',test.value->>'botId') IS DISTINCT FROM $9::text
      THEN 'settings_changed'
    WHEN p.snapshot_id<>$2::uuid OR p.pending_snapshot_id IS DISTINCT FROM $3::uuid
      OR p.status<>$4 OR p.destination_id<>$6 THEN 'snapshot_changed'
    WHEN EXISTS(SELECT 1 FROM operational_state WHERE key='publication_removal:'||p.id::text)
      OR s.status IN ('failed','rejected')
      OR EXISTS(SELECT 1 FROM operational_state failed WHERE failed.key LIKE 'pipeline_failed_item:%'
        AND failed.value->'storyIds' @> to_jsonb(ARRAY[s.id::text]))
      OR EXISTS(SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
        JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=s.id
        AND r.metadata @> '{"pipelineFailure":true}'::jsonb) THEN 'story_ineligible'
    WHEN EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation=$8
      AND (a.status IN ('running','unknown','succeeded') OR (a.response_metadata->>'terminalUnknown'='true' AND a.response_metadata->>'snapshotId'=coalesce(p.pending_snapshot_id,p.snapshot_id)::text))
      AND ($8='send' OR a.status<>'succeeded')) THEN 'delivery_outcome_unknown'
    WHEN s.id IS NULL AND NOT coalesce(($7 AND test.value->>'publicationId'=p.id::text
      AND test.value->>'destinationId'=p.destination_id),false) THEN 'story_ineligible'
    WHEN s.id IS NOT NULL AND (snap.story_version IS DISTINCT FROM s.content_version
      OR snap.generation_id IS DISTINCT FROM (SELECT j.id FROM judgments j WHERE j.story_id=s.id
        AND j.stage='generation_research' AND j.result->>'headline'=s.headline
        AND j.result->>'summary' IS NOT DISTINCT FROM s.summary ORDER BY j.created_at DESC,j.id DESC LIMIT 1))
      THEN 'snapshot_changed'
    ELSE NULL END AS reason,s.id AS story_id,
      coalesce((settings.value->>'collectionWindowHours')::integer,$10) AS collection_window_hours
    FROM publications p JOIN publication_snapshots snap ON snap.id=coalesce(p.pending_snapshot_id,p.snapshot_id)
    LEFT JOIN stories s ON s.id=snap.story_id
    LEFT JOIN app_settings settings ON settings.id=1
    LEFT JOIN operational_state target ON target.key='telegram_destination'
    LEFT JOIN operational_state verified ON verified.key='bot_verified'
    LEFT JOIN operational_state test ON test.key='bot_verification_test'
    WHERE p.id=$1 FOR UPDATE OF p`, [publication.id,publication.snapshot_id,publication.pending_snapshot_id,
    operation === 'send' ? 'prepared' : 'published',publication.bot_id,publication.destination_id,Boolean(authorization.verificationTest),operation,botId,settings.collectionWindowHours])).rows[0];
  if (!row || row.reason) return { allowed:false,reason:row?.reason ?? 'snapshot_changed' };
  // Navigation/correction edits do not republish news. Verification tests have no story inputs.
  if (operation === 'edit' || !row.story_id) return { allowed:true };
  const query = client.query.bind(client);
  const boundary = await preparedPublicationInputs(publication.id, query);
  if (!boundary) return { allowed: false, reason: 'publication_input_unverifiable' };
  return publicationInputAdmission(row.story_id, publication.destination_id,
    { ...settings, collectionWindowHours: row.collection_window_hours }, query, { boundary });
}

/** Policy denials are not Telegram attempts. Permanently invalid reserved sends cannot resume. */
export async function recordAdmissionDenial(client: Pick<PoolClient, 'query'>, publication: Publication,
  operation: Operation, reason: Extract<PublicationAdmission, { allowed: false }>['reason']): Promise<void> {
  const snapshotId = publication.pending_snapshot_id ?? publication.snapshot_id;
  const recorded = await client.query<{ first_seen: boolean }>(`INSERT INTO operational_state(key,value) VALUES($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=operational_state.value||EXCLUDED.value||jsonb_build_object(
      'at',coalesce(operational_state.value->>'at',EXCLUDED.value->>'at'),
      'occurrences',CASE WHEN operational_state.value->>'occurrences' ~ '^[0-9]{1,8}$'
        THEN least((operational_state.value->>'occurrences')::integer+1,99999999) ELSE 2 END),updated_at=now()
    RETURNING (xmax=0) AS first_seen`,
  [`publication_admission:${publication.id}:${snapshotId}:${reason}`, JSON.stringify({
    publicationId: publication.id, snapshotId, operation, reason, at: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(), occurrences: 1,
  })]);
  if (recorded.rows[0]?.first_seen) console.warn('Publication admission denied', {
    publicationId: publication.id, snapshotId, operation, reason,
  });
  if (operation === 'edit' && (reason === 'snapshot_changed' || reason === 'story_ineligible' || reason === 'settings_changed')) {
    await settleEdit(client,publication.id,snapshotId,`publication_admission_${reason}`);
  }
  if (operation === 'send' && (reason === 'snapshot_changed' || reason === 'story_ineligible'
    || reason === 'stale_source_input' || reason === 'no_new_source_input' || reason === 'publication_input_unverifiable')) {
    await client.query(`UPDATE publications p SET status='failed',error_code=$2,next_retry_at=NULL,updated_at=now()
      WHERE p.id=$1 AND p.status='prepared' AND p.message_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='send'
          AND a.status IN ('running','unknown','succeeded'))`,
    [publication.id,`publication_admission_${reason}`]);
    await releaseDestination(publication.id,client);
  }
}
