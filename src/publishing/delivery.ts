import { z } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { BotApi, BotError, telegramTimeouts } from './bot-api.js';
import { render, renderPublication, PublicationRenderError, type RenderedMessage } from './render.js';
import { readSentMessage, ReconciliationReviewError, sendMetadata } from './reconciliation.js';
import { settleExpiredPublications, publicationEditSelect, rateLimited, type Publication } from './store.js';
import { publicationAdmission, recordAdmissionDenial, type DeliveryAuthorization } from './freshness.js';
import { reconcileUnknownEdit } from './edit-reconciliation.js';
import { preparePublicationMedia } from './media-plan.js';
import { destinationBlocked, releaseDestination } from './destination-order.js';
import { deliverMediaFirst } from './media-first-delivery.js';
export { readSentMessage } from './reconciliation.js';

export async function recordFailure(attemptId: string, publication: Publication, operation: 'send' | 'edit' | 'delete', error: unknown,
  settings: AppSettings): Promise<void> {
  const failure = error instanceof BotError ? error : new BotError('telegram_outcome_unknown', 'unknown');
  const delay = Math.max(failure.retryAfterMs, Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.min(publication.attempt_count, 10)));
  const retryAt = failure.outcome === 'failed' ? null : new Date(Date.now() + delay);
  await transaction(async client => {
    await client.query(`UPDATE request_attempts SET status=$1,error_code=$2,next_retry_at=$3,finished_at=now() WHERE id=$4`,
      [failure.outcome,failure.code,retryAt,attemptId]);
    if (operation === 'send') {
      await client.query(`UPDATE publications SET status=$1,error_code=$2,next_retry_at=$3,updated_at=now() WHERE id=$4`,
        [failure.outcome === 'unknown' ? 'uncertain' : failure.outcome === 'retryable' ? 'prepared' : 'failed',failure.code,retryAt,publication.id]);
      if (failure.outcome !== 'retryable') await releaseDestination(publication.id,client);
    }
  });
}

export async function beginAttempt(publication: Publication, operation: 'send' | 'edit' | 'delete', metadata: object,
  settings?: AppSettings, authorization: DeliveryAuthorization = {}): Promise<string | null> {
  if (operation !== 'delete' && (await settleExpiredPublications(publication.destination_id,publication.id))
    .some(item => item.kind === operation && (operation === 'send' || item.snapshot_id === (publication.pending_snapshot_id ?? publication.snapshot_id)))) return null;
  return transaction(async client => {
    if (await destinationBlocked(publication.destination_id, operation === 'send' && publication.delivery_kind === 'media_first' ? publication.id : undefined, client)) return null;
    if (operation === 'send' && publication.delivery_kind === 'media_first' && (await client.query(`SELECT 1 FROM publication_media_batches
      WHERE publication_id=$1 AND status IN ('prepared','retryable','running') LIMIT 1`, [publication.id])).rows.length) return null;
    if (operation !== 'delete') {
      if (!settings) throw new Error('Publication admission requires current settings');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
      const admission = await publicationAdmission(client,publication,settings,operation,authorization,
        z.object({botId:z.string()}).safeParse(metadata).data?.botId ?? publication.bot_id);
      if (!admission.allowed) {
        await recordAdmissionDenial(client, publication, operation, admission.reason);
        return null;
      }
    }
    if(operation==='delete') {
      if(!settings) throw new Error('Replacement deletion requires current settings');
      const proof=z.object({canonicalPublicationId:z.uuid(),canonicalSnapshotId:z.uuid()}).parse(metadata);
      await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
      const canonical=(await client.query<Publication>(`${publicationEditSelect} WHERE p.id=$1`,[proof.canonicalPublicationId])).rows[0];
      if(!canonical || canonical.snapshot_id!==proof.canonicalSnapshotId || canonical.pending_snapshot_id
        || !(await publicationAdmission(client,canonical,settings,'edit')).allowed) return null;
      const duplicate=(await client.query<Publication & {same_story:boolean}>(`SELECT d.*,snap.content,
        coalesce(da.canonical_story_id,dm.canonical_story_id,d.story_id)=coalesce(ca.canonical_story_id,cm.canonical_story_id,c.story_id) AS same_story
        FROM publication_replacements r JOIN publications d ON d.id=r.duplicate_publication_id
        JOIN publication_snapshots snap ON snap.id=d.snapshot_id JOIN publications c ON c.id=r.canonical_publication_id
        LEFT JOIN story_publication_aliases da ON da.publication_id=d.id LEFT JOIN story_merges dm ON dm.merged_story_id=d.story_id
        LEFT JOIN story_publication_aliases ca ON ca.publication_id=c.id LEFT JOIN story_merges cm ON cm.merged_story_id=c.story_id
        WHERE d.id=$1 AND r.status='pending' AND r.canonical_publication_id=$2 AND r.canonical_snapshot_id=$3
          AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||d.id::text)
          AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=d.id AND a.operation<>'delete' AND a.status IN('running','unknown'))
        FOR UPDATE OF d,r`,[publication.id,proof.canonicalPublicationId,proof.canonicalSnapshotId])).rows[0];
      if(!duplicate || !duplicate.same_story || duplicate.status!=='published' || duplicate.pending_snapshot_id
        || duplicate.message_id!==publication.message_id || duplicate.destination_id!==publication.destination_id
        || duplicate.snapshot_id!==publication.snapshot_id || duplicate.bot_id!==canonical.bot_id
        || duplicate.destination_id!==canonical.destination_id) return null;
    }
    // Replace the durable desired edit atomically, including on retry after restart.
    if (operation === 'edit') await client.query(`UPDATE request_attempts SET status='failed',error_code='edit_superseded',finished_at=now(),next_retry_at=NULL
      WHERE publication_id=$1 AND operation='edit' AND status='retryable'`, [publication.id]);
    const result = await client.query<{ id: string }>(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      SELECT $1,'telegram-bot',$2,coalesce(max(attempt_number),0)+1,'running',$3 FROM request_attempts WHERE publication_id=$1 RETURNING id`,
      [publication.id,operation,JSON.stringify(metadata)]);
    const attempt = result.rows[0];
    if (!attempt) throw new Error('Publication attempt insert failed');
    if (operation === 'send') await client.query(`UPDATE publications SET status='sending',attempt_count=attempt_count+1,
      bot_id=coalesce(bot_id,$2),updated_at=now() WHERE id=$1`,
    [publication.id,z.object({ botId:z.string() }).safeParse(metadata).data?.botId ?? null]);
    return attempt.id;
  });
}

export async function sendPrepared(publication: Publication, api: BotApi, settings: AppSettings,
  authorization: DeliveryAuthorization = {}): Promise<string | null> {
  if (publication.status !== 'prepared' || publication.message_id || publication.delivery_kind === 'album') return null;
  if ((await settleExpiredPublications(publication.destination_id,publication.id)).some(item => item.kind === 'send')) return null;
  if (await destinationBlocked(publication.destination_id, publication.delivery_kind === 'media_first' ? publication.id : undefined)) return null;
  try {
    await preparePublicationMedia(publication, settings);
    const planned = (await db.query<Pick<Publication, 'delivery_kind' | 'media_status' | 'media_snapshot_id'>>(
      'SELECT delivery_kind,media_status,media_snapshot_id FROM publications WHERE id=$1', [publication.id])).rows[0];
    if (!planned) return null;
    publication = { ...publication, ...planned };
  } catch (error) {
    const failure = error instanceof BotError ? error : new BotError('publication_media_prepare_failed', 'retryable');
    if (failure.outcome === 'retryable') {
      await db.query(`UPDATE publications SET error_code=$2,next_retry_at=$3,updated_at=now()
        WHERE id=$1 AND status='prepared'`, [publication.id,failure.code,
        new Date(Date.now() + Math.max(failure.retryAfterMs, settings.retryBaseMs))]);
      return null;
    }
    await transaction(async client => {
      await client.query(`UPDATE publication_media_batches SET status='failed',error_code=$2,next_retry_at=NULL
        WHERE publication_id=$1 AND status IN ('prepared','retryable')`, [publication.id,failure.code]);
      await client.query(`UPDATE publications SET media_status=$2,media_snapshot_id=snapshot_id,error_code=$3,
        next_retry_at=NULL,updated_at=now() WHERE id=$1 AND status='prepared'`, [publication.id,failure.outcome,failure.code]);
    });
    publication = { ...publication,media_status:failure.outcome,media_snapshot_id:publication.snapshot_id };
  }
  let message: RenderedMessage;
  try { message = render(publication.content); }
  catch (error) {
    if (error instanceof BotError) return null;
    if (!(error instanceof PublicationRenderError)) throw error;
    await db.query(`UPDATE publications SET status='failed',error_code=$2,next_retry_at=NULL,updated_at=now()
      WHERE id=$1 AND status='prepared'`, [publication.id,error.code]);
    return null;
  }
  if (publication.delivery_kind === 'media_first') {
    if (!await deliverMediaFirst(publication,api,settings,authorization)) return null;
    const current = (await db.query<Publication>(`SELECT * FROM publications WHERE id=$1`, [publication.id])).rows[0];
    if (!current) return null;
    publication = { ...publication, ...current };
  }
  if (await rateLimited()) return null;
  const bot = await api.identity();
  if (publication.bot_id && publication.bot_id !== String(bot.id)) throw new Error('Publication bot ownership changed');
  const timeouts = telegramTimeouts();
  const requestTimeoutMs = timeouts.requestMs;
  const attemptId = await beginAttempt(publication, 'send', { ...sendMetadata(message), deliveryKind: publication.delivery_kind ?? 'text', requestTimeoutMs, botId:String(bot.id) }, settings, authorization);
  if (!attemptId) return null;
  let messageId: string;
  try {
    messageId = await api.send(publication.destination_id, message);
  }
  catch (error) { await recordFailure(attemptId,publication,'send',error,settings); return null; }
  await transaction(async client => {
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),response_metadata=response_metadata||$1::jsonb WHERE id=$2`,
      [JSON.stringify({ ...sendMetadata(message), messageId }),attemptId]);
    await client.query(`UPDATE publications SET status='published',message_id=$1,published_at=now(),updated_at=now(),
      next_retry_at=NULL,error_code=CASE media_status WHEN 'pending' THEN 'publication_media_pending'
        WHEN 'unknown' THEN 'publication_media_requires_review' WHEN 'failed' THEN 'publication_media_failed' ELSE NULL END,
      format_version=1 WHERE id=$2`, [messageId,publication.id]);
    await releaseDestination(publication.id,client);
  });
  return messageId;
}

export async function editPublication(publication: Publication, api: BotApi, settings: AppSettings,
  authorization: DeliveryAuthorization = {}): Promise<boolean> {
  if (!publication.message_id || publication.status !== 'published') return false;
  if ((await settleExpiredPublications(publication.destination_id,publication.id)).some(item => item.kind === 'edit'
    && item.snapshot_id === (publication.pending_snapshot_id ?? publication.snapshot_id))) return false;
  const reconciled = await reconcileUnknownEdit(publication);
  if (reconciled !== null) return reconciled;
  let message: RenderedMessage;
  try { message = renderPublication(publication); }
  catch (error) {
    if (!(error instanceof PublicationRenderError)) throw error;
    await db.query(`UPDATE publications SET error_code='publication_navigation_requires_new_edition',updated_at=now() WHERE id=$1`, [publication.id]);
    return false;
  }
  if (publication.bot_id !== String((await api.identity()).id)) return false;
  const snapshotId = publication.pending_snapshot_id ?? publication.snapshot_id;
  const attemptId = await beginAttempt(publication,'edit',{ snapshotId, ...sendMetadata(message) },settings,authorization);
  if (!attemptId) return false;
  try {
    if (publication.delivery_kind === 'album') await api.editCaption(publication.destination_id,publication.message_id,message);
    else await api.edit(publication.destination_id,publication.message_id,message);
  }
  catch (error) { await recordFailure(attemptId,publication,'edit',error,settings); return false; }
  await transaction(async client => {
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL WHERE id=$1`, [attemptId]);
    await client.query(`UPDATE publications SET snapshot_id=$1,pending_snapshot_id=NULL,format_version=1,updated_at=now()
      WHERE id=$2 AND coalesce(pending_snapshot_id,snapshot_id)=$1`, [snapshotId,publication.id]);
  });
  return true;
}

export async function reconcile(publication: Publication, settings: AppSettings,
  reader?: (publication: Publication) => Promise<string | null>): Promise<boolean> {
  if ((await settleExpiredPublications(publication.destination_id,publication.id)).some(item => item.kind === 'send')) return false;
  let receipt: string | null;
  try { receipt = await (reader ?? readSentMessage)(publication); }
  catch (error) {
    const code = error instanceof ReconciliationReviewError ? 'send_not_found_requires_review' : 'reconciliation_unavailable';
    await transaction(async client => {
      await client.query(`UPDATE publications SET status='uncertain',error_code=$1,next_retry_at=$2,updated_at=now() WHERE id=$3`,
        [code,code === 'send_not_found_requires_review' ? null : new Date(Date.now()+settings.retryMaxMs),publication.id]);
      await releaseDestination(publication.id,client);
    });
    return false;
  }
  if (!receipt) {
    await transaction(async client => {
      await client.query(`UPDATE publications SET status='uncertain',error_code='send_not_found_requires_review',next_retry_at=NULL,updated_at=now() WHERE id=$1`,
        [publication.id]);
      await releaseDestination(publication.id,client);
    });
    return false;
  }
  const messageId = receipt;
  await transaction(async client => {
    await client.query(`UPDATE publications SET status='published',message_id=$1,published_at=coalesce(published_at,now()),
      next_retry_at=NULL,error_code=CASE media_status WHEN 'pending' THEN 'publication_media_pending'
        WHEN 'unknown' THEN 'publication_media_requires_review' WHEN 'failed' THEN 'publication_media_failed' ELSE NULL END,
      format_version=1,updated_at=now() WHERE id=$2`, [messageId,publication.id]);
    await releaseDestination(publication.id,client);
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata || $1::jsonb WHERE publication_id=$2 AND operation='send' AND status IN ('running','unknown')`,
      [JSON.stringify({ messageId, reconciled: true }),publication.id]);
  });
  return true;
}
