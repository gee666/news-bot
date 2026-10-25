import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { beginAttempt, recordFailure } from './delivery.js';
import { deletePublicationMessages } from './media-delivery.js';
import { publicationSelect, rateLimited, type Publication } from './store.js';

interface Replacement { duplicate_publication_id: string; canonical_publication_id: string; canonical_snapshot_id: string }

/** Delete only durable bot-owned replacement records whose canonical full edit is still current. */
export async function retryReplacements(api: BotApi, settings: AppSettings, destinationId: string): Promise<number> {
  let deleted = 0;
  const botId = String((await api.identity()).id);
  const replacements = (await db.query<Replacement>(`SELECT r.* FROM publication_replacements r
    JOIN publications c ON c.id=r.canonical_publication_id JOIN publications d ON d.id=r.duplicate_publication_id
    WHERE r.status='pending' AND (r.next_retry_at IS NULL OR r.next_retry_at<=now())
      AND c.status='published' AND c.format_version=1 AND c.pending_snapshot_id IS NULL AND c.snapshot_id=r.canonical_snapshot_id
      AND c.destination_id=$1 AND d.destination_id=$1 AND c.bot_id=$2 AND d.bot_id=$2
      AND d.status='published' AND d.message_id IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key IN ('publication_removal:'||d.id::text,'publication_removal:'||c.id::text))`, [destinationId,botId])).rows;
  for (const replacement of replacements) {
    if (await rateLimited()) break;
    const publication = (await db.query<Publication>(`${publicationSelect} WHERE p.id=$1`, [replacement.duplicate_publication_id])).rows[0];
    if (!publication?.message_id) continue;
    const attemptId = await beginAttempt(publication,'delete',{ canonicalPublicationId: replacement.canonical_publication_id,
      canonicalSnapshotId: replacement.canonical_snapshot_id },settings);
    if (!attemptId) continue;
    try {
      await deletePublicationMessages(publication, api);
    }
    catch (error) {
      await recordFailure(attemptId,publication,'delete',error,settings);
      const failure = error instanceof BotError ? error : new BotError('telegram_outcome_unknown','unknown');
      await db.query(`UPDATE publication_replacements SET status=$1,error_code=$2,next_retry_at=$3 WHERE duplicate_publication_id=$4`,
        [failure.outcome === 'failed' ? 'failed' : 'pending',failure.code,
          failure.outcome === 'failed' ? null : new Date(Date.now() + Math.max(settings.retryMaxMs,failure.retryAfterMs)),publication.id]);
      continue;
    }
    await transaction(async client => {
      await client.query("UPDATE request_attempts SET status='succeeded',finished_at=now(),next_retry_at=NULL WHERE id=$1", [attemptId]);
      await client.query(`UPDATE publication_replacements SET status='deleted',deleted_at=now(),error_code=NULL,next_retry_at=NULL
        WHERE duplicate_publication_id=$1`, [publication.id]);
    });
    deleted++;
  }
  return deleted;
}
