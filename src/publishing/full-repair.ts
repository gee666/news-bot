import { db, transaction } from '../db.js';
import { getSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { actionKey, fullRepairContinuation, fullRepairPlan, fullRepairPlanHash, loadAction, snapshotHash } from './approval.js';
import { beginAttempt, recordFailure } from './delivery.js';
import { sendMetadata } from './reconciliation.js';
import { locked, publicationEditSelect, type Publication } from './store.js';
import { deliverPublicationText } from './text-delivery.js';
import { PublicationRenderError } from './render.js';

/** Explicit operator invocation only. Never called by automatic repair, retries or selection. */
export async function executeReviewedFullRepair(id: string, api = new BotApi()): Promise<boolean> {
  return locked('news-bot-digest', async () => {
    const action = await loadAction(db,id);
    if (!action || action.operation !== 'edit' || !action.fullContentRepair) throw new Error('Reviewed full-content repair approval missing');
    const repair = action.fullContentRepair;
    return locked(`news-bot-publication:${action.publicationId}`,async () => {
      const loaded = (await db.query<Publication>(`${publicationEditSelect} WHERE p.id=$1`,[action.publicationId])).rows[0];
      if (!loaded) return false;
      let publication: Publication = loaded;
      if (publication.status !== 'published' || publication.delivery_kind !== 'album'
        || publication.message_id !== action.messageId || publication.destination_id !== action.destinationId
        || publication.bot_id !== repair.botId
        || (publication.media_snapshot_id ?? null) !== repair.mediaSnapshotId) return false;
      if (String((await api.identity()).id) !== publication.bot_id) throw new Error('Approved publication bot ownership changed');
      const settings = await getSettings();
      if (publication.snapshot_id === action.desiredSnapshotId && !publication.pending_snapshot_id) {
        // Restart after the successful caption commit: only finish its frozen continuations.
        if (!await fullRepairContinuation(db,publication)) return false;
      } else {
        if (action.state !== 'approved' || Date.parse(action.expiresAt) <= Date.now()
          || publication.snapshot_id !== action.priorSnapshotId || publication.pending_snapshot_id !== action.desiredSnapshotId
          || snapshotHash(publication.content) !== action.snapshotHash) return false;
        const parts = fullRepairPlan(publication.content,repair.reviewedCaption);
        if (parts.length !== 1) throw new PublicationRenderError('publication_text_requires_new_edition');
        const caption = parts[0];
        if (!caption) throw new Error('Reviewed full-content repair plan empty');
        const attemptId = await beginAttempt(publication,'edit',{
          snapshotId:action.desiredSnapshotId,fullContentRepair:true,parts,...sendMetadata(caption),
        },settings,{ approvalId:id,fullContentRepair:true,fullRepairPlanHash:fullRepairPlanHash(parts) });
        if (!attemptId) return false;
        try { await api.editCaption(publication.destination_id,action.messageId,caption); }
        catch (error) {
          await recordFailure(attemptId,publication,'edit',error,settings,async client => {
            const outcome = error instanceof BotError ? error.outcome : 'unknown';
            await client.query(`UPDATE operational_state SET value=value||jsonb_build_object('state',$2::text),updated_at=now() WHERE key=$1`,
              [actionKey(id),outcome === 'retryable' ? 'approved' : outcome === 'unknown' ? 'uncertain' : 'failed']);
          });
          return false;
        }
        await transaction(async client => {
          const changed = await client.query(`UPDATE publications SET snapshot_id=$2,pending_snapshot_id=NULL,format_version=1,updated_at=now()
            WHERE id=$1 AND snapshot_id=$3 AND pending_snapshot_id=$2`,[publication.id,action.desiredSnapshotId,action.priorSnapshotId]);
          if (changed.rowCount !== 1) throw new Error('Reviewed repair changed during caption request; manual reconciliation required');
          await client.query('DELETE FROM publication_text_parts WHERE publication_id=$1',[publication.id]);
          for (const [number,part] of parts.entries()) await client.query(`INSERT INTO publication_text_parts
            (publication_id,part_number,snapshot_id,content,status,message_id) VALUES($1,$2,$3,$4,$5,$6)`,
          [publication.id,number,action.desiredSnapshotId,JSON.stringify(part),number === 0 ? 'sent' : 'prepared',number === 0 ? action.messageId : null]);
          await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL WHERE id=$1`,[attemptId]);
        });
        publication = { ...publication,snapshot_id:action.desiredSnapshotId,pending_snapshot_id:null };
      }
      if (!await deliverPublicationText(publication,api,settings)) return false;
      await db.query(`UPDATE operational_state SET value=value||jsonb_build_object('state','completed','finishedAt',now()),updated_at=now() WHERE key=$1`,[actionKey(id)]);
      return true;
    });
  });
}
