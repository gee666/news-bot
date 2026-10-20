import type { PoolClient } from 'pg';
import { z } from 'zod';
import { settingsSchema, type AppSettings } from '../settings.js';
import { publicationSnapshotSchema } from '../types.js';
import { blockedStoriesCte } from '../pipeline/item-failures.js';
import { generationIsCurrent } from '../pipeline/generation-freshness.js';
import { eligible, snapshotFor, snapshotSources } from './content.js';
import { loadAction, snapshotHash, type DeliveryAuthorization } from './approval.js';
import { rateLimited,unsafeSendAttempt,type Publication } from './store.js';
import { lockAdmissionInputs } from './admission-locks.js';

type Reason = 'settings_changed' | 'publishing_paused' | 'snapshot_changed' | 'story_ineligible'
  | 'retained_provenance_unknown' | 'current_generation_missing'
  | 'delivery_outcome_unknown' | 'approval_invalid' | 'publication_removed' | 'telegram_cooldown' | 'consolidation_unresolved';
export type PublicationAdmission = { allowed: true } | { allowed: false; reason: Reason };
const deny = (reason: Reason): PublicationAdmission => ({ allowed: false, reason });
const storySchema = z.object({ id: z.uuid(), headline: z.string(), summary: z.string().nullable(),
  translated_excerpt: z.string().nullable(), chosen_excerpt: z.string().nullable(), researched: z.boolean(),
  interest_score: z.number().int(), content_version: z.number().int() });

/** Read-only policy check. The attempt boundary calls it while holding history/publication row locks. */
export async function publicationAdmission(client: Pick<PoolClient,'query'>, publication: Publication, settings: AppSettings,
  operation: 'send' | 'edit', authorization: DeliveryAuthorization = {}): Promise<PublicationAdmission> {
  try {
    const saved = settingsSchema.parse((await client.query<{ value: unknown }>('SELECT value FROM app_settings WHERE id=1 FOR SHARE')).rows[0]?.value);
    if (await rateLimited(client)) return deny('telegram_cooldown');
    if (JSON.stringify(saved) !== JSON.stringify(settingsSchema.parse(settings))) return deny('settings_changed');
    const canonicalId = await lockAdmissionInputs(client,publication.id);
    if (canonicalId === undefined) return deny('snapshot_changed');
    const row = (await client.query<Publication & { canonical_story_id: string | null; desired_story_id: string | null; story: unknown; eligible: boolean }>(`
      SELECT p.*,desired.content,desired.story_id AS desired_story_id,coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id) AS canonical_story_id,
        to_jsonb(s) AS story,coalesce((${eligible}),false) AS eligible
      FROM publications p JOIN publication_snapshots desired ON desired.id=coalesce(p.pending_snapshot_id,p.snapshot_id)
      LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
      LEFT JOIN stories s ON s.id=coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)
      WHERE p.id=$5 AND $1::text IS NOT NULL FOR UPDATE OF p`,
    [publication.destination_id,saved.minimumPublicationScore,saved.profileVersion,saved.modelVersion,publication.id])).rows[0];
    if (!row || row.canonical_story_id !== canonicalId || row.destination_id !== publication.destination_id || row.message_id !== publication.message_id
      || row.status !== publication.status || row.snapshot_id !== publication.snapshot_id || row.pending_snapshot_id !== publication.pending_snapshot_id
      || snapshotHash(row.content) !== snapshotHash(publication.content)) return deny('snapshot_changed');
    if ((await client.query('SELECT 1 FROM operational_state WHERE key=$1', [`publication_removal:${row.id}`])).rows.length) return deny('publication_removed');
    if (operation === 'send' && (row.status !== 'prepared' || row.message_id)) return deny('delivery_outcome_unknown');
    if (operation === 'edit' && (row.status !== 'published' || !row.message_id)) return deny('delivery_outcome_unknown');
    const unsafe = await client.query(`SELECT 1 FROM request_attempts a WHERE a.publication_id=$1 AND a.operation=$2
      AND (($2='send' AND ${unsafeSendAttempt}) OR ($2='edit' AND a.status IN ('running','unknown'))) LIMIT 1`,[row.id,operation]);
    if (unsafe.rows.length) return deny('delivery_outcome_unknown');
    let explicit = false;
    let approvedReceiptId: string | undefined;
    if (authorization.approvalId) {
      const action = await loadAction(client,authorization.approvalId);
      if (!action || action.state !== 'approved' || Date.parse(action.expiresAt) <= Date.now() || action.operation !== operation
        || action.publicationId !== row.id || action.destinationId !== row.destination_id || action.messageId !== row.message_id
        || action.priorSnapshotId !== row.snapshot_id || action.desiredSnapshotId !== row.pending_snapshot_id
        || action.snapshotHash !== snapshotHash(row.content) || action.storyId !== row.canonical_story_id) return deny('approval_invalid');
      const story = storySchema.safeParse(row.story);
      if (!story.success || story.data.content_version !== action.contentVersion || !action.receiptId) return deny('approval_invalid');
      approvedReceiptId = action.receiptId;
      explicit = true;
    }
    if (authorization.verificationTest && row.canonical_story_id === null) {
      const test = z.object({ publicationId: z.uuid(), destinationId: z.string(), botId: z.number().int().positive() }).safeParse(
        (await client.query<{ value: unknown }>("SELECT value FROM operational_state WHERE key='bot_verification_test'")).rows[0]?.value);
      if (test.success && test.data.publicationId === row.id && test.data.destinationId === row.destination_id
        && (operation === 'send' && !row.bot_id || row.bot_id === String(test.data.botId))
        && row.desired_story_id === null && publicationSnapshotSchema.parse(row.content).sources.length === 0
        && !(await client.query(`SELECT 1 FROM story_publication_aliases WHERE publication_id=$1
          UNION ALL SELECT 1 FROM publication_replacements WHERE duplicate_publication_id=$1`,[row.id])).rows.length) return { allowed: true };
      return deny('approval_invalid');
    }
    if (!saved.publishingEnabled && !explicit) return deny('publishing_paused');
    if (!row.canonical_story_id || row.desired_story_id !== row.canonical_story_id) return deny('retained_provenance_unknown');
    const quarantined=await client.query(`WITH RECURSIVE ${blockedStoriesCte} SELECT 1 WHERE $1::text IN(SELECT id FROM blocked_stories)
      OR EXISTS(SELECT 1 FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
        JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=$1::uuid
        AND r.metadata ? 'pipelineFailure' AND r.metadata->'pipelineFailure' IS DISTINCT FROM 'false'::jsonb)`,[row.canonical_story_id]);
    if(quarantined.rows.length) return deny('story_ineligible');
    if (z.object({status:z.enum(['failed','rejected'])}).safeParse(row.story).success) return deny('story_ineligible');
    if (operation === 'edit') {
      const sent = publicationSnapshotSchema.parse((await client.query<{ content: unknown }>(
        'SELECT content FROM publication_snapshots WHERE id=$1', [row.snapshot_id])).rows[0]?.content);
      const desired = publicationSnapshotSchema.parse(row.content);
      if (snapshotHash({ ...sent, sources: [] }) === snapshotHash({ ...desired, sources: [] })) {
        const story = storySchema.parse(row.story);
        const { sources } = await snapshotSources(client, { ...story, headline: sent.headline,
          summary: sent.detailsKind === 'summary' ? sent.details : null }, undefined, row.destination_id);
        return snapshotHash({ ...sent, sources }) === snapshotHash(desired) ? { allowed: true } : deny('snapshot_changed');
      }
    }
    if (!row.eligible) return deny('story_ineligible');
    const story = storySchema.parse(row.story);
    if (!await generationIsCurrent(story.id,saved,client.query.bind(client),approvedReceiptId)) return deny('current_generation_missing');
    const currentSnapshot = await snapshotFor(client,story,approvedReceiptId);
    if (snapshotHash(currentSnapshot) !== snapshotHash(row.content)) return deny('snapshot_changed');
    return { allowed: true };
  } catch (error) {
    if (error instanceof z.ZodError) return deny('retained_provenance_unknown');
    throw error;
  }
}
