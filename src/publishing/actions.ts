import { z } from 'zod';
import { db, transaction } from '../db.js';
import { getSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { editPublication, recordFailure } from './delivery.js';
import { deletePublicationMessages } from './media-delivery.js';
import { actionKey, loadAction, snapshotHash } from './approval.js';
import { locked, publicationEditSelect, rateLimited, type Publication } from './store.js';

async function finishAction(id: string, state: 'completed' | 'uncertain' | 'failed'): Promise<void> {
  await db.query(`UPDATE operational_state SET value=value||jsonb_build_object('state',$2::text,'finishedAt',now()),updated_at=now()
    WHERE key=$1`,[actionKey(id),state]);
}

/** Explicit persisted coordinator approval only. No selection tick, new sends or implicit deletion. */
export async function executeReviewedAction(id: string, api = new BotApi()): Promise<boolean> {
  return locked('news-bot-digest', async () => {
    const action = await loadAction(db,id);
    if (!action) throw new Error('Publication action approval missing');
    // Full-content media repairs require their own explicit, lossless executor.
    if (action.operation === 'edit' && action.fullContentRepair) return false;
    if (action.state === 'completed') return true;
    if (action.state !== 'approved' || Date.parse(action.expiresAt) <= Date.now()) return false;
    return locked(`news-bot-publication:${action.publicationId}`,async () => {
      const publication = (await db.query<Publication>(`${publicationEditSelect} WHERE p.id=$1`,[action.publicationId])).rows[0];
      if (!publication || publication.status !== 'published' || publication.message_id !== action.messageId
        || publication.destination_id !== action.destinationId || publication.snapshot_id !== action.priorSnapshotId
        || publication.pending_snapshot_id !== action.desiredSnapshotId || snapshotHash(publication.content) !== action.snapshotHash) return false;
      if (String((await api.identity()).id) !== publication.bot_id) throw new Error('Approved publication bot ownership changed');
      const settings = await getSettings();
      if (action.operation === 'edit') {
        const changed = await editPublication(publication,api,settings,{ approvalId: id });
        const result = (await db.query<{ status: string }>(`SELECT status FROM request_attempts WHERE publication_id=$1
          AND response_metadata->>'approvalId'=$2 ORDER BY dispatched_at DESC,id DESC LIMIT 1`,[publication.id,id])).rows[0];
        if (changed) await finishAction(id,'completed');
        else if (result) await finishAction(id,result.status === 'unknown' ? 'uncertain' : 'failed');
        return changed;
      }
      // Spurious historical news removal is separately authorized, never inferred from rejection alone.
      const attemptId = await transaction(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
        const current = (await client.query<{ status: string; content_version: number; headline: string | null; summary: string | null }>(
          'SELECT status,content_version,headline,summary FROM stories WHERE id=$1 FOR UPDATE',[action.storyId])).rows[0];
        const owned=(await client.query<Publication & {canonical_id:string}>(`SELECT p.*,snap.content,
          coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) AS canonical_id FROM publications p
          JOIN publication_snapshots snap ON snap.id=p.snapshot_id LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
          LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id WHERE p.id=$1 FOR UPDATE OF p`,[publication.id])).rows[0];
        const approval = await loadAction(client,id);
        if (!approval || JSON.stringify(approval)!==JSON.stringify(action) || approval.state !== 'approved' || Date.parse(approval.expiresAt) <= Date.now()
          || !current || current.status !== 'rejected' || current.content_version !== action.contentVersion || current.headline || current.summary
          || !owned || owned.story_id !== action.storyId || owned.canonical_id !== action.storyId || snapshotHash(owned.content)!==action.snapshotHash
          || owned.message_id !== action.messageId
          || owned.destination_id !== action.destinationId || owned.snapshot_id !== action.priorSnapshotId || owned.pending_snapshot_id
          || owned.status !== 'published' || owned.bot_id !== publication.bot_id) return null;
        if (await rateLimited(client)) return null;
        if ((await client.query(`SELECT 1 FROM request_attempts WHERE publication_id=$1 AND status IN ('running','unknown')`,[owned.id])).rows.length) return null;
        const removal = (await client.query<{ value: unknown }>('SELECT value FROM operational_state WHERE key=$1 FOR UPDATE',
          [`publication_removal:${owned.id}`])).rows[0];
        if (removal) {
          const retry = z.object({ state: z.literal('retryable'), approvalId: z.string(), snapshotId: z.string(), messageId: z.string() }).safeParse(removal.value);
          if (!retry.success || retry.data.approvalId !== id || retry.data.snapshotId !== owned.snapshot_id || retry.data.messageId !== owned.message_id) return null;
        }
        const attempt = (await client.query<{ id: string }>(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,response_metadata)
          SELECT $1,'telegram-bot','delete',coalesce(max(attempt_number),0)+1,'running',$2 FROM request_attempts WHERE publication_id=$1 RETURNING id`,
        [owned.id,JSON.stringify({ approvalId:id,snapshotId:action.priorSnapshotId,reason:'coordinator_approved_spurious_event' })])).rows[0];
        if (!attempt) throw new Error('Removal attempt insert failed');
        await client.query(`INSERT INTO operational_state(key,value) VALUES($1,$2)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[`publication_removal:${owned.id}`,
          JSON.stringify({ publicationId:owned.id,messageId:owned.message_id,approvalId:id,snapshotId:owned.snapshot_id,state:'running' })]);
        await client.query(`UPDATE operational_state SET value=value||'{"state":"running"}'::jsonb,updated_at=now() WHERE key=$1`,[actionKey(id)]);
        return attempt.id;
      });
      if (!attemptId) return false;
      try {
        await deletePublicationMessages(publication, api);
      }
      catch (error) {
        const retryable = error instanceof BotError && error.outcome === 'retryable' && error.code === 'telegram_rate_limit';
        // The rejection and retry authorization must survive a restart together.
        await recordFailure(attemptId,publication,'delete',error,settings,async client => {
          await client.query(`UPDATE operational_state SET value=value||jsonb_build_object('state',$2::text),updated_at=now() WHERE key=$1`,
            [`publication_removal:${publication.id}`, retryable ? 'retryable' : 'uncertain']);
          await client.query(`UPDATE operational_state SET value=value||jsonb_build_object('state',$2::text),updated_at=now() WHERE key=$1`,
            [actionKey(id), retryable ? 'approved' : 'uncertain']);
        });
        return false;
      }
      await transaction(async client => {
        await client.query(`UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL WHERE id=$1`,[attemptId]);
        await client.query(`UPDATE operational_state SET value=value||jsonb_build_object('state','deleted','deletedAt',now()),updated_at=now()
          WHERE key=$1`,[`publication_removal:${publication.id}`]);
        await client.query(`UPDATE operational_state SET value=value||jsonb_build_object('state','completed','finishedAt',now()),updated_at=now() WHERE key=$1`,[actionKey(id)]);
      });
      return true;
    });
  });
}
