import { db, transaction } from '../db.js';
import { generationIsCurrent } from '../pipeline/generation-freshness.js';
import { getSettings, type AppSettings } from '../settings.js';
import { publicationSnapshotSchema } from '../types.js';
import { BotApi, BotError } from './bot-api.js';
import { publicationAdmission } from './freshness.js';
import { beginAttempt, editPublication, recordFailure } from './delivery.js';
import { deletePublicationMessages } from './media-delivery.js';
import { canonicalPublications, prepareUpdates } from './updates.js';
import { destination, eligible, locked, publicationEditSelect, publicationSelect, rateLimited, snapshotFor, state, type Publication, type StoryContent } from './store.js';
import { editVerificationTest, repairEditBlocked, trackedVerificationTest, verifiedBotSchema } from './repair-test.js';

export interface RepairOptions { includeVerificationTest?: boolean }
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

/** Explicit reviewed invocation authorizes corrections, never new sends or unrelated channel content. */
export async function repairExistingPublications(settings: AppSettings, options: RepairOptions = {}): Promise<{ edited: number; deleted: number }> {
  return locked('news-bot-digest', async () => {
    const current = await getSettings();
    if (settings.profileVersion !== current.profileVersion || settings.modelVersion !== current.modelVersion) throw new Error('Repair settings changed');
    const destinationId = await destination();
    const verified = verifiedBotSchema.parse(await state('bot_verified'));
    const api = new BotApi();
    const botId = String((await api.identity()).id);
    if (verified.destinationId !== destinationId || String(verified.botId) !== botId) throw new Error('Repair bot verification changed');
    const test = options.includeVerificationTest ? await trackedVerificationTest(db,destinationId,botId) : undefined;
    await prepareUpdates(current,destinationId,undefined,{ sourceRepair: true });
    const candidates = (await db.query<{ id: string; canonical_story_id: string }>(canonicalPublications, [destinationId])).rows;
    let edited = 0;
    for (const candidate of candidates) {
      if (await rateLimited()) break;
      await locked(`news-bot-publication:${candidate.id}`, async client => {
        const publication = (await client.query<Publication>(`${publicationEditSelect} WHERE p.id=$1`, [candidate.id])).rows[0];
        const story = (await client.query<StoryContent>(`SELECT s.* FROM stories s WHERE ${eligible} AND $1::text IS NOT NULL AND s.id=$5`,
          [destinationId,current.minimumPublicationScore,current.profileVersion,current.modelVersion,candidate.canonical_story_id])).rows[0];
        if (!publication || !story || publication.bot_id !== botId || !await generationIsCurrent(story.id,current,client.query.bind(client))) return;
        const desired = await snapshotFor(client,story);
        if (JSON.stringify(desired) !== JSON.stringify(publicationSnapshotSchema.parse(publication.content))) return;
        if (publication.format_version !== 1 || publication.pending_snapshot_id !== null) {
          if (await repairEditBlocked(client,publication.id,publication.pending_snapshot_id ?? publication.snapshot_id)
            || !await editPublication(publication,api,current)) return;
          edited++;
        }
        await transaction(async tx => {
          await tx.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
          const latestStory = (await tx.query<StoryContent>(`SELECT s.* FROM stories s WHERE ${eligible} AND $1::text IS NOT NULL AND s.id=$5 FOR UPDATE`,
            [destinationId,current.minimumPublicationScore,current.profileVersion,current.modelVersion,story.id])).rows[0];
          if (!latestStory || !await generationIsCurrent(story.id,current,tx.query.bind(tx)) || JSON.stringify(await snapshotFor(tx,latestStory)) !== JSON.stringify(desired)) return;
          const canonical=(await tx.query<Publication>(`${publicationEditSelect} WHERE p.id=$1`,[publication.id])).rows[0];
          if(!canonical || !(await publicationAdmission(tx,canonical,current,'edit')).allowed) return;
          // Persist authorization after the successful edit. Recovery can retry deletion safely.
          await tx.query(`INSERT INTO publication_replacements(duplicate_publication_id,canonical_publication_id,canonical_snapshot_id)
            SELECT d.id,c.id,c.snapshot_id FROM publications d
            LEFT JOIN story_publication_aliases pa ON pa.publication_id=d.id
            LEFT JOIN story_merges sm ON sm.merged_story_id=d.story_id
            JOIN publications c ON c.id=$1
            WHERE coalesce(pa.canonical_story_id,sm.canonical_story_id,d.story_id)=$2 AND d.id<>c.id
              AND d.destination_id=c.destination_id AND d.status='published' AND d.message_id IS NOT NULL
              AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||d.id::text)
              AND c.pending_snapshot_id IS NULL AND c.format_version=1 AND d.bot_id=$3 AND c.bot_id=$3
            ON CONFLICT(duplicate_publication_id) DO UPDATE SET canonical_publication_id=EXCLUDED.canonical_publication_id,
              canonical_snapshot_id=EXCLUDED.canonical_snapshot_id
            WHERE publication_replacements.status='pending'`, [publication.id,story.id,botId]);
        });
      });
    }
    if (test && await editVerificationTest(api,current,destinationId,botId,test.id)) edited++;
    return { edited, deleted: await retryReplacements(api,current,destinationId) };
  });
}
