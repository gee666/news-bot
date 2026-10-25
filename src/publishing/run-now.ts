import { z } from 'zod';
import { db } from '../db.js';
import { getSettings, type AppSettings } from '../settings.js';
import { BotApi } from './bot-api.js';
import { reconcile, sendPrepared } from './delivery.js';
import { recoverEdits, recoverSends } from './digest.js';
import { checkPublicationAdmission } from './admission.js';
import { guardDigestEligibility } from '../pipeline/eligibility.js';
import { prepareUpdates, retryEdits } from './updates.js';
import { retryPublicationMedia } from './media-delivery.js';
import { recoverPublicationText, retryPublicationText } from './text-delivery.js';
import { retryNavigationParts } from './navigation-delivery.js';
import { prepareThreadUpdates } from './thread-updates.js';
import { recoverPublicationMedia } from './media-plan.js';
import { reservedPublication } from './destination-order.js';
import { destination, prepareDigest, publicationSelect, rateLimited, refreshPrepared, state, type Publication } from './store.js';

export interface ManualPublicationResult {
  published: number; updated: number; waiting: boolean; reasons: Record<string, number>;
}

const editTargetSchema = z.object({ publicationId: z.uuid(), snapshotId: z.uuid() });
const selectionSchema = z.object({ ids: z.array(z.uuid()), destinationId: z.string(), botId: z.number(),
  omitted: z.number().int().nonnegative(), editTargets: z.array(editTargetSchema).default([]) });

async function deliveryCounts(selection: z.infer<typeof selectionSchema> | undefined, createdAt: string) {
  if (!selection) return { published: 0, updated: 0 };
  const published = await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM publications
    WHERE id=ANY($1::uuid[]) AND status='published' AND media_status IN ('none','complete')
      AND NOT EXISTS(SELECT 1 FROM publication_text_parts t WHERE t.publication_id=publications.id AND t.status<>'sent')
      AND NOT EXISTS(SELECT 1 FROM publication_navigation_parts n WHERE n.publication_id=publications.id AND n.status<>'sent')`, [selection.ids]);
  const edited = await db.query<{ count: number }>(`SELECT count(DISTINCT a.publication_id)::int AS count FROM request_attempts a
    WHERE a.operation='edit' AND a.status='succeeded' AND a.finished_at>=$2 AND EXISTS(
      SELECT 1 FROM jsonb_to_recordset($1::jsonb) target("publicationId" uuid,"snapshotId" uuid)
      WHERE a.publication_id=target."publicationId" AND a.response_metadata->>'snapshotId'=target."snapshotId"::text)`,
  [JSON.stringify(selection.editTargets), createdAt]);
  return { published: published.rows[0]?.count ?? 0, updated: edited.rows[0]?.count ?? 0 };
}

/** Caller holds the pipeline, refresh and digest leases. No history selection or unrelated retries. */
export async function publishRunNow(settings: AppSettings, runId: string, storyIds: string[], limit: number,
  createdAt: string): Promise<ManualPublicationResult> {
  const saved = selectionSchema.safeParse(await state(`run_now_publications:${runId}`));
  const report: ManualPublicationResult = { ...await deliveryCounts(saved.success ? saved.data : undefined, createdAt),
    waiting: false, reasons: {} };
  const current = await getSettings();
  if (!current.publishingEnabled) { report.reasons.publishing_disabled = 1; return report; }
  if (current.profileVersion !== settings.profileVersion || current.modelVersion !== settings.modelVersion) {
    report.reasons.settings_changed = 1; return report;
  }
  let destinationId: string;
  try { destinationId = await destination(); }
  catch { report.reasons.destination_not_configured = 1; return report; }
  const reservedId = await reservedPublication(destinationId);
  if (reservedId && (!saved.success || !saved.data.ids.includes(reservedId))) {
    report.reasons.destination_reserved = 1; report.waiting = true; return report;
  }
  const verification = z.object({ verified: z.literal(true), destinationId: z.literal(destinationId), botId: z.number() })
    .safeParse(await state('bot_verified'));
  if (!verification.success) { report.reasons.bot_not_verified = 1; return report; }
  if (saved.success && saved.data.destinationId !== destinationId) { report.reasons.destination_changed = 1; return report; }
  if (saved.success && saved.data.botId !== verification.data.botId) { report.reasons.bot_identity_changed = 1; return report; }
  const api = new BotApi();
  if ((await api.identity()).id !== verification.data.botId) { report.reasons.bot_identity_changed = 1; return report; }
  await guardDigestEligibility(current, storyIds);
  const stale = (await db.query<{ count: number }>(`SELECT count(*)::int AS count FROM stories
    WHERE id=ANY($1::uuid[]) AND status='completed' AND interest_stale`, [storyIds])).rows[0]?.count ?? 0;
  if (stale) report.reasons.eligibility_or_ranking_stale = stale;
  const ids = await prepareDigest(current, destinationId, { runId, storyIds, limit, botId: verification.data.botId });
  const selection = z.object({ omitted: z.number().int().nonnegative() }).parse(await state(`run_now_publications:${runId}`));
  if (selection.omitted) report.reasons.publication_selection_limit = selection.omitted;
  const prior = await db.query<{ status: string; count: number }>(`SELECT p.status,count(*)::int AS count FROM publications p
    LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    WHERE p.destination_id=$1 AND coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=ANY($2::uuid[])
      AND NOT (p.id=ANY($3::uuid[])) AND p.status<>'published' GROUP BY p.status`, [destinationId, storyIds, ids]);
  for (const row of prior.rows) report.reasons[`existing_publication_${row.status}`] = row.count;
  // Selection commits before any network send. Retry/restart always uses these same IDs.
  await recoverSends(destinationId, ids);
  await recoverPublicationMedia(destinationId);
  await recoverPublicationText(destinationId,ids);
  const selected = await db.query<Publication & { error_code: string | null }>(`${publicationSelect}
    WHERE p.id=ANY($1::uuid[]) AND p.destination_id=$2 ORDER BY p.created_at,p.id`, [ids, destinationId]);
  const withheld = new Set<string>();
  for (const publication of selected.rows) {
    const owner = await reservedPublication(destinationId);
    if (owner && owner !== publication.id) continue;
    if (await rateLimited()) break;
    if (publication.next_retry_at && publication.next_retry_at > new Date()) continue;
    if (publication.status === 'uncertain' && publication.error_code !== 'send_not_found_requires_review') {
      await reconcile(publication, current);
      continue;
    }
    if (publication.status !== 'prepared') continue;
    const latest = await getSettings();
    if (!latest.publishingEnabled || latest.profileVersion !== settings.profileVersion || latest.modelVersion !== settings.modelVersion
      || await destination() !== destinationId) break;
    if (publication.story_id) await guardDigestEligibility(latest, [publication.story_id]);
    if (!await refreshPrepared(publication, latest)) {
      withheld.add(publication.id);
      const admission = await checkPublicationAdmission(publication, latest, 'send');
      const reason = admission.allowed ? 'current_generation_or_eligibility_missing' : admission.reason;
      report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
      continue;
    }
    const desired = (await db.query<Publication>(`${publicationSelect} WHERE p.id=$1 AND p.status='prepared'`, [publication.id])).rows[0];
    if (desired) {
      const admission = await checkPublicationAdmission(desired, latest, 'send');
      if (!admission.allowed) {
        withheld.add(publication.id);
        report.reasons[admission.reason] = (report.reasons[admission.reason] ?? 0) + 1;
      } else if (!await sendPrepared(desired, api, latest)) {
        const status = (await db.query<{ status: string }>('SELECT status FROM publications WHERE id=$1', [desired.id])).rows[0]?.status;
        if (status === 'prepared' && !await rateLimited()) {
          const admission = await checkPublicationAdmission(desired, latest, 'send');
          const reason = admission.allowed ? 'publication_admission_changed' : admission.reason;
          withheld.add(desired.id); report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
        }
      }
    }
  }
  await recoverEdits(destinationId, storyIds);
  await prepareUpdates(current, destinationId, storyIds, { runId });
  const receipt = selectionSchema.parse(await state(`run_now_publications:${runId}`));
  if (!await rateLimited()) await retryEdits(api, current, destinationId, storyIds);
  if (!await rateLimited()) await retryPublicationText(api, current, destinationId, ids);
  if (!await rateLimited()) await retryPublicationMedia(api, current, destinationId);
  await prepareThreadUpdates(destinationId,ids);
  const navigationIds = (await db.query<{ id: string }>(`SELECT p.id FROM publications p JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id
    WHERE p.destination_id=$1 AND (p.id=ANY($2::uuid[]) OR desired.content->>'updatedTo' IN
      (SELECT 'https://t.me/c/'||substring(destination_id from 5)||'/'||message_id FROM publications WHERE id=ANY($2::uuid[]) AND message_id IS NOT NULL)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(desired.content->'sources') source WHERE source->>'relatedPublication'='true'
        AND source->>'url' IN(SELECT 'https://t.me/c/'||substring(destination_id from 5)||'/'||message_id
          FROM publications WHERE id=ANY($2::uuid[]) AND message_id IS NOT NULL)))`, [destinationId,ids])).rows.map(row => row.id);
  if (navigationIds.length && !await rateLimited()) await retryEdits(api,current,destinationId,undefined,navigationIds);
  const navigationScope=[...new Set([...ids,...navigationIds])];
  if (!await rateLimited()) await retryNavigationParts(api,current,destinationId,navigationScope);
  const navigationProblems = await db.query<{ status:string; count:number }>(`SELECT status,count(*)::int AS count
    FROM publication_navigation_parts WHERE publication_id=ANY($1::uuid[]) AND status<>'sent' GROUP BY status`,[navigationScope]);
  for (const problem of navigationProblems.rows) {
    report.reasons[`publication_navigation_${problem.status}`]=problem.count;
    if (['prepared','retryable','running'].includes(problem.status)) report.waiting=true;
  }
  const textProblems = await db.query<{ status: string; count: number }>(`SELECT status,count(*)::int AS count FROM publication_text_parts
    WHERE publication_id=ANY($1::uuid[]) AND status<>'sent' GROUP BY status`, [ids]);
  for (const problem of textProblems.rows) {
    report.reasons[`publication_text_${problem.status}`] = problem.count;
    if (['prepared','retryable','running'].includes(problem.status)) report.waiting = true;
  }
  const outcomes = await db.query<{ id: string; status: string; error_code: string | null; media_status?: string }>(`SELECT id,status,error_code,media_status
    FROM publications WHERE id=ANY($1::uuid[])`, [ids]);
  for (const row of outcomes.rows) {
    if (row.status === 'uncertain' && row.error_code !== 'send_not_found_requires_review' || row.status === 'sending'
      || row.status === 'prepared' && !withheld.has(row.id)) report.waiting = true;
    if (row.status === 'published' && row.media_status && !['none', 'complete'].includes(row.media_status)) {
      report.reasons[row.error_code ?? 'publication_media_pending'] = (report.reasons[row.error_code ?? 'publication_media_pending'] ?? 0) + 1;
      if (row.media_status === 'pending') report.waiting = true;
    }
    if (row.status !== 'published' && !withheld.has(row.id)) {
      const reason = row.error_code ?? row.status;
      report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
    }
  }
  Object.assign(report, await deliveryCounts(receipt, createdAt));
  const editProblems = await db.query<{ status: string; error_code: string | null; count: number }>(`SELECT a.status,a.error_code,count(*)::int AS count
    FROM request_attempts a JOIN publications p ON p.id=a.publication_id
    LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    WHERE p.destination_id=$1 AND (coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)=ANY($2::uuid[])
      OR EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) target("publicationId" uuid,"snapshotId" uuid)
        WHERE a.publication_id=target."publicationId" AND a.response_metadata->>'snapshotId'=target."snapshotId"::text))
      AND a.operation IN ('edit','prepare_edit') AND a.status IN ('running','unknown','retryable','failed')
      AND a.error_code IS DISTINCT FROM 'edit_superseded'
      AND NOT EXISTS(SELECT 1 FROM request_attempts newer WHERE newer.publication_id=a.publication_id AND newer.operation='edit'
        AND newer.attempt_number>a.attempt_number)
    GROUP BY a.status,a.error_code`, [destinationId, storyIds, JSON.stringify(receipt.editTargets)]);
  for (const problem of editProblems.rows) {
    const reason = `edit_${problem.error_code ?? problem.status}`;
    report.reasons[reason] = problem.count;
    if (problem.status !== 'failed') report.waiting = true;
  }
  if (await rateLimited()) { report.reasons.telegram_rate_limit = 1; report.waiting = true; }
  return report;
}
