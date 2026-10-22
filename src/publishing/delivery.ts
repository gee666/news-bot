import { z } from 'zod';
import { telegramTimeouts } from './telegram-transport.js';
import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { BotApi, BotError, mediaUploadType } from './bot-api.js';
import { renderCaption } from './caption.js';
import { render, PublicationRenderError, type RenderedMessage } from './render.js';
import { readSentMessage, readSentPublication, ReconciliationReviewError, sendMetadata, type AlbumReceipt } from './reconciliation.js';
import { publicationEditSelect, type Publication } from './store.js';
import { publicationAdmission } from './freshness.js';
import { checkPublicationAdmission, recordAdmissionDenial } from './admission.js';
import type { DeliveryAuthorization } from './approval.js';
import { reconcileUnknownEdit } from './edit-reconciliation.js';
import { preparePublicationMedia } from './media-plan.js';
import { claimAlbum, completeAlbum, readAlbumPlan, recordAlbumFailure, type AlbumPlan } from './album-delivery.js';
import { deliverPublicationMedia } from './media-delivery.js';
export { readSentMessage } from './reconciliation.js';

export async function recordFailure(attemptId: string, publication: Publication, operation: 'send' | 'edit' | 'delete', error: unknown,
  settings: AppSettings, onRecorded?: (client: Pick<PoolClient, 'query'>) => Promise<void>): Promise<void> {
  const failure = error instanceof BotError ? error : new BotError('telegram_outcome_unknown', 'unknown');
  const delay = Math.max(failure.retryAfterMs, Math.min(settings.retryMaxMs, settings.retryBaseMs * 2 ** Math.min(publication.attempt_count, 10)));
  const retryAt = failure.outcome === 'failed' ? null : new Date(Date.now() + delay);
  await transaction(async client => {
    await client.query(`UPDATE request_attempts SET status=$1,error_code=$2,next_retry_at=$3,finished_at=now() WHERE id=$4`,
      [failure.outcome,failure.code,retryAt,attemptId]);
    if (operation === 'send') await recordAlbumFailure(client, publication, failure, retryAt);
    if (operation === 'send') await client.query(`UPDATE publications SET status=$1,error_code=$2,next_retry_at=$3,updated_at=now() WHERE id=$4`,
      [failure.outcome === 'unknown' ? 'uncertain' : failure.outcome === 'retryable' ? 'prepared' : 'failed',failure.code,retryAt,publication.id]);
    await onRecorded?.(client);
  });
}

export async function beginAttempt(publication: Publication, operation: 'send' | 'edit' | 'delete', metadata: object,
  settings?: AppSettings, authorization: DeliveryAuthorization = {}): Promise<string | null> {
  return transaction(async client => {
    if (operation !== 'delete') {
      if (!settings) throw new Error('Publication admission requires current settings');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
      const admission = await publicationAdmission(client,publication,settings,operation,authorization);
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
    if (operation === 'send' && publication.delivery_kind === 'album' && !await claimAlbum(client, publication, metadata)) return null;
    // Replace the durable desired edit atomically, including on retry after restart.
    if (operation === 'edit') await client.query(`UPDATE request_attempts SET status='failed',error_code='edit_superseded',finished_at=now(),next_retry_at=NULL
      WHERE publication_id=$1 AND operation='edit' AND status='retryable'`, [publication.id]);
    const result = await client.query<{ id: string }>(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
      SELECT $1,'telegram-bot',$2,coalesce(max(attempt_number),0)+1,'running',$3 FROM request_attempts WHERE publication_id=$1 RETURNING id`,
      [publication.id,operation,JSON.stringify({ ...metadata, ...(authorization.approvalId ? { approvalId: authorization.approvalId } : {}) })]);
    const attempt = result.rows[0];
    if (!attempt) throw new Error('Publication attempt insert failed');
    if (authorization.approvalId) await client.query(`UPDATE operational_state SET value=value||'{"state":"running"}'::jsonb,updated_at=now()
      WHERE key=$1`, [`publication_action:${authorization.approvalId}`]);
    if (operation === 'send') await client.query(`UPDATE publications SET status='sending',attempt_count=attempt_count+1,
      bot_id=coalesce(bot_id,$2),updated_at=now() WHERE id=$1`,
    [publication.id,z.object({ botId:z.string() }).safeParse(metadata).data?.botId ?? null]);
    return attempt.id;
  });
}

export async function sendPrepared(publication: Publication, api: BotApi, settings: AppSettings,
  authorization: DeliveryAuthorization = {}): Promise<string | null> {
  if (publication.status !== 'prepared' || publication.message_id) return null;
  if (!(await checkPublicationAdmission(publication,settings,'send',authorization)).allowed) return null;
  let hasMedia: boolean;
  let album: AlbumPlan | undefined;
  try {
    hasMedia = await preparePublicationMedia(publication, settings, true);
    const planned = (await db.query<Pick<Publication, 'delivery_kind' | 'media_status' | 'media_snapshot_id'>>(
      'SELECT delivery_kind,media_status,media_snapshot_id FROM publications WHERE id=$1', [publication.id])).rows[0];
    if (!planned) return null;
    publication = { ...publication, ...planned };
    if (publication.delivery_kind === 'album') album = await readAlbumPlan(publication);
  } catch (error) {
    const failure = error instanceof BotError ? error : new BotError('publication_media_prepare_failed', 'retryable');
    await db.query(`UPDATE publications SET status=$2,error_code=$3,next_retry_at=$4,updated_at=now()
      WHERE id=$1 AND status='prepared'`, [publication.id,
      failure.outcome === 'failed' ? 'failed' : failure.outcome === 'unknown' ? 'uncertain' : 'prepared', failure.code,
      failure.outcome === 'retryable' ? new Date(Date.now() + Math.max(failure.retryAfterMs, settings.retryBaseMs)) : null]);
    return null;
  }
  const albumMetadata = album ? { deliveryKind: 'album', itemIds: album.items.map(item => item.id),
    uploadTypes: album.media.map(mediaUploadType), mediaDigests: album.items.map(item => item.digest) } : { deliveryKind: 'text' };
  let message: RenderedMessage;
  try { message = publication.delivery_kind === 'album' ? renderCaption(publication.content) : render(publication.content); }
  catch (error) {
    if (!(error instanceof PublicationRenderError)) throw error;
    const attemptId = await beginAttempt(publication, 'send', { ...albumMetadata, phase: 'preflight' }, settings, authorization);
    if (!attemptId) return null;
    await recordFailure(attemptId, publication, 'send', new BotError(error.code, 'failed'), settings);
    return null;
  }
  const bot = await api.identity();
  if (publication.bot_id && publication.bot_id !== String(bot.id)) throw new Error('Publication bot ownership changed');
  const timeouts = telegramTimeouts();
  const requestTimeoutMs = album ? timeouts.uploadMs : timeouts.requestMs;
  const attemptId = await beginAttempt(publication, 'send', { ...sendMetadata(message), ...albumMetadata, requestTimeoutMs, botId:String(bot.id) }, settings, authorization);
  if (!attemptId) return null;
  let messageId: string;
  try {
    if (album) {
      const ids = await api.sendAlbum(publication.destination_id, message, album.media);
      await completeAlbum(publication, attemptId, ids, sendMetadata(message));
      return ids[0] ?? null;
    }
    messageId = await api.send(publication.destination_id, message);
  }
  catch (error) { await recordFailure(attemptId,publication,'send',error,settings); return null; }
  await transaction(async client => {
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),response_metadata=response_metadata||$1::jsonb WHERE id=$2`,
      [JSON.stringify({ ...sendMetadata(message), messageId }),attemptId]);
    await client.query(`UPDATE publications SET status='published',message_id=$1,published_at=now(),updated_at=now(),
      next_retry_at=NULL,error_code=CASE WHEN media_status='pending' THEN 'publication_media_pending' ELSE NULL END,
      format_version=1 WHERE id=$2`, [messageId,publication.id]);
  });
  if (hasMedia && !await deliverPublicationMedia({ ...publication, status: 'published', message_id: messageId,
    bot_id: String(bot.id) }, api, settings)) return null;
  return messageId;
}

export async function editPublication(publication: Publication, api: BotApi, settings: AppSettings,
  authorization: DeliveryAuthorization = {}): Promise<boolean> {
  if (!publication.message_id || publication.status !== 'published') return false;
  const reconciled = await reconcileUnknownEdit(publication);
  if (reconciled !== null) return reconciled;
  if (!(await checkPublicationAdmission(publication,settings,'edit',authorization)).allowed) return false;
  let message: RenderedMessage;
  try { message = publication.delivery_kind === 'album' ? renderCaption(publication.content) : render(publication.content); }
  catch (error) {
    if (!(error instanceof PublicationRenderError)) throw error;
    const attemptId = await beginAttempt(publication, 'edit', { snapshotId: publication.pending_snapshot_id ?? publication.snapshot_id, phase: 'render' }, settings, authorization);
    if (!attemptId) throw error;
    await recordFailure(attemptId, publication, 'edit', new BotError(error.code, 'failed'), settings);
    throw error;
  }
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
  reader?: (publication: Publication) => Promise<string | AlbumReceipt | null>): Promise<boolean> {
  let receipt: string | AlbumReceipt | null;
  try { receipt = await (reader ?? (publication.delivery_kind === 'album' ? readSentPublication : readSentMessage))(publication); }
  catch (error) {
    const code = error instanceof ReconciliationReviewError ? 'send_not_found_requires_review' : 'reconciliation_unavailable';
    await db.query(`UPDATE publications SET status='uncertain',error_code=$1,next_retry_at=$2,updated_at=now() WHERE id=$3`,
      [code,new Date(Date.now()+settings.retryMaxMs),publication.id]);
    return false;
  }
  if (!receipt || publication.delivery_kind === 'album' && typeof receipt === 'string') {
    await db.query(`UPDATE publications SET status='uncertain',error_code='send_not_found_requires_review',next_retry_at=$1,updated_at=now() WHERE id=$2`,
      [new Date(Date.now()+settings.retryMaxMs),publication.id]);
    return false;
  }
  if (publication.delivery_kind === 'album' && typeof receipt !== 'string') {
    if (receipt.messageId !== receipt.messageIds[0]) return false;
    try { await completeAlbum(publication, null, receipt.messageIds, { reconciled: true }); return true; }
    catch { return false; }
  }
  const messageId = typeof receipt === 'string' ? receipt : receipt.messageId;
  await transaction(async client => {
    await client.query(`UPDATE publications SET status='published',message_id=$1,published_at=coalesce(published_at,now()),
      next_retry_at=NULL,error_code=CASE WHEN media_status='pending' THEN 'publication_media_pending' ELSE NULL END,
      format_version=1,updated_at=now() WHERE id=$2`, [messageId,publication.id]);
    await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL,
      response_metadata=response_metadata || $1::jsonb WHERE publication_id=$2 AND operation='send' AND status IN ('running','unknown')`,
      [JSON.stringify({ messageId, reconciled: true }),publication.id]);
  });
  return true;
}
