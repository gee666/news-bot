import { newsOrderTime } from './ordering.js';
import { z } from 'zod';
import { db, transaction } from '../db.js';
import { getSettings, type AppSettings } from '../settings.js';
import { BotApi } from './bot-api.js';
import { reconcile, sendPrepared } from './delivery.js';
import { checkPublicationAdmission } from './admission.js';
import { recoverNavigationParts, retryNavigationParts } from './navigation-delivery.js';
import { prepareThreadUpdates } from './thread-updates.js';
import { deliverPublicationText, recoverPublicationText, retryPublicationText } from './text-delivery.js';
import { retryEdits } from './updates.js';
import { prepareReadyStories } from './ready.js';
import { retryReplacements } from './repair.js';
import { recoverPublicationMedia } from './media-plan.js';
import { retryPublicationMedia } from './media-delivery.js';
import { reservedPublication, releaseDestination } from './destination-order.js';
import { adoptPreparedPublications, destination, locked, publicationSelect, rateLimited, refreshPrepared, state, tryLocked, unsafeSendAttempt, type Publication } from './store.js';

const verificationSchema = z.object({ verified: z.literal(true), destinationId: z.string(), botId: z.number().int().positive() });
const due = '(p.next_retry_at IS NULL OR p.next_retry_at<=now())';
const reviewExcluded = "p.error_code IS DISTINCT FROM 'send_not_found_requires_review'";

export async function recoverSends(destinationId: string, publicationIds?: string[]): Promise<void> {
  await db.query(`UPDATE publications SET status='uncertain',error_code='restart_send_unknown',
      next_retry_at=greatest(next_retry_at,now()+interval '5 minutes'),updated_at=now()
    WHERE destination_id=$1 AND ($2::uuid[] IS NULL OR id=ANY($2)) AND (status='sending' OR (status='prepared' AND EXISTS(
      SELECT 1 FROM request_attempts a WHERE a.publication_id=publications.id AND a.operation='send'
        AND ${unsafeSendAttempt})))`, [destinationId, publicationIds ?? null]);
  await db.query(`UPDATE request_attempts a SET status='unknown',error_code='restart_send_unknown',finished_at=now(),
      next_retry_at=greatest(a.next_retry_at,p.next_retry_at)
    FROM publications p WHERE a.publication_id=p.id AND p.destination_id=$1 AND a.operation='send'
      AND ($2::uuid[] IS NULL OR p.id=ANY($2))
      AND a.status IN ('running','retryable','failed') AND ${unsafeSendAttempt}`, [destinationId, publicationIds ?? null]);
}

export async function recoverEdits(destinationId: string, storyIds?: string[]): Promise<void> {
  await db.query(`UPDATE request_attempts a SET status='unknown',error_code='restart_edit_unknown',finished_at=now(),
    next_retry_at=greatest(a.next_retry_at,now()+interval '5 minutes')
    FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
      LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    WHERE a.publication_id=p.id AND p.destination_id=$1 AND a.operation='edit' AND a.status='running'
      AND ($2::uuid[] IS NULL OR coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=ANY($2))`,
  [destinationId, storyIds ?? null]);
}

async function dispatch(settings: AppSettings, selectNewStories: boolean): Promise<void> {
  const current = await getSettings();
  if (!current.publishingEnabled || current.profileVersion !== settings.profileVersion || current.modelVersion !== settings.modelVersion) return;
  const destinationId = await destination();
  const verification = verificationSchema.safeParse(await state('bot_verified'));
  if (!verification.success || verification.data.destinationId !== destinationId) return;
  await recoverSends(destinationId);
  await recoverEdits(destinationId);
  await recoverPublicationMedia(destinationId);
  await recoverPublicationText(destinationId);
  await recoverNavigationParts(destinationId);
  await prepareThreadUpdates(destinationId);
  if (await rateLimited()) return;
  if (!selectNewStories) {
    const row = (await db.query<{ pending: boolean }>(`SELECT EXISTS(SELECT 1 FROM publication_destination_reservations WHERE destination_id=$1)
      OR EXISTS(SELECT 1 FROM publications p WHERE p.destination_id=$1
      AND ${due} AND ((p.status='prepared' AND (p.story_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM story_publication_aliases pa WHERE pa.publication_id=p.id))) OR (p.status='uncertain' AND ${reviewExcluded})
        OR (p.status='published' AND (p.pending_snapshot_id IS NOT NULL OR (p.media_status='pending' AND (
          NOT EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status<>'sent')
          OR EXISTS(SELECT 1 FROM publication_media_batches b WHERE b.publication_id=p.id AND b.status IN ('prepared','retryable')
            AND (b.next_retry_at IS NULL OR b.next_retry_at<=now()))))))
        OR EXISTS(SELECT 1 FROM publication_text_parts t WHERE t.publication_id=p.id AND t.part_number>0
          AND t.status IN ('prepared','retryable') AND (t.next_retry_at IS NULL OR t.next_retry_at<=now()))
        OR EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id AND r.status='pending'
          AND (r.next_retry_at IS NULL OR r.next_retry_at<=now()))
        OR EXISTS(SELECT 1 FROM publication_navigation_parts n WHERE n.publication_id=p.id
          AND n.status IN ('prepared','retryable','unknown') AND (n.next_retry_at IS NULL OR n.next_retry_at<=now()))
        OR EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit'
          AND a.status IN ('running','retryable','unknown') AND (a.next_retry_at IS NULL OR a.next_retry_at<=now()))))
      AS pending`, [destinationId])).rows[0];
    if (!row?.pending) return;
  }
  const api = new BotApi();
  if ((await api.identity()).id !== verification.data.botId) return;
  const reservedId = await reservedPublication(destinationId);
  if (reservedId) {
    const owner = (await db.query<Publication & { error_code: string | null }>(`${publicationSelect} WHERE p.id=$1`, [reservedId])).rows[0];
    if (owner && (!owner.next_retry_at || owner.next_retry_at <= new Date())) {
      if (owner.status === 'uncertain' && owner.error_code !== 'send_not_found_requires_review') await reconcile(owner,current);
      else if (owner.status === 'prepared') await sendPrepared(owner,api,current);
      else if (owner.status === 'published') {
        await deliverPublicationText(owner,api,current);
        await transaction(client => releaseDestination(owner.id,client));
      }
    }
    if (await reservedPublication(destinationId)) return;
  }
  const uncertain = await db.query<Publication>(`${publicationSelect} WHERE p.destination_id=$1 AND p.status='uncertain'
    AND ${reviewExcluded} AND ${due} ORDER BY p.created_at`, [destinationId]);
  for (const publication of uncertain.rows) await reconcile(publication,current);
  if (await rateLimited()) return;
  // Only digest runs consume ready events; maintenance resumes authorized work.
  if (selectNewStories) await prepareReadyStories(current,destinationId);
  await adoptPreparedPublications(current,destinationId);
  await retryEdits(api,current,destinationId);
  await retryNavigationParts(api,current,destinationId);
  await retryReplacements(api,current,destinationId);
  await retryPublicationText(api,current,destinationId);
  await retryPublicationMedia(api,current,destinationId);
  const prepared = await db.query<Publication>(`${publicationSelect} JOIN stories news ON news.id=p.story_id WHERE p.destination_id=$1 AND p.story_id IS NOT NULL
    AND p.status='prepared' AND ${due}
    AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=p.story_id)
    ORDER BY ${newsOrderTime('news')},p.id`, [destinationId]);
  for (const publication of prepared.rows) {
    const latest = await getSettings();
    if (!latest.publishingEnabled || await rateLimited()) break;
    if (await destination() !== destinationId) break;
    const content = await refreshPrepared(publication,latest);
    if (!content) {
      await checkPublicationAdmission(publication, latest, 'send');
      continue;
    }
    const desired = (await db.query<Publication>(`${publicationSelect} WHERE p.id=$1 AND p.status='prepared'`,[publication.id])).rows[0];
    if (desired) await sendPrepared(desired,api,latest);
    if (await reservedPublication(destinationId)) return;
  }
  await prepareThreadUpdates(destinationId);
  await retryEdits(api,current,destinationId);
  await retryNavigationParts(api,current,destinationId);
}

export async function publishDigest(settings: AppSettings): Promise<void> {
  if (!settings.publishingEnabled) return;
  await locked('news-bot-digest', () => dispatch(settings,true));
}

export async function resumePublications(settings: AppSettings): Promise<void> {
  if (!settings.publishingEnabled) return;
  // Never wait behind an active digest/verification or nest its lease.
  await tryLocked('news-bot-digest', () => dispatch(settings,false));
}
