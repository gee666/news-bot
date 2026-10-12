import type { PoolClient } from 'pg';
import { generationIsCurrent } from '../pipeline/generation-freshness.js';
import { ZodError } from 'zod';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import { BotApi } from './bot-api.js';
import { editPublication } from './delivery.js';
import { PublicationRenderError, render } from './render.js';
import { eligible, locked, publicationEditSelect, rateLimited, snapshotFor, supersedeAttempts, type Publication, type StoryContent } from './store.js';

/** One tracked survivor per canonical event and destination. Alias audit survives story pruning. */
export const canonicalPublications = `SELECT DISTINCT ON (s.id) p.id,s.id AS canonical_story_id
  FROM publications p LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id
  LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
  JOIN stories s ON s.id=coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)
  WHERE p.destination_id=$1 AND p.status='published' AND p.message_id IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||p.id::text)
    AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id)
  ORDER BY s.id,(coalesce(pa.original_story_id,p.story_id)=s.id) DESC,p.published_at NULLS LAST,p.created_at,p.id`;

async function cancelEdits(client: PoolClient, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await client.query(`INSERT INTO operational_state(key,value)
    SELECT 'publication_edit_cancel:'||id::text||':'||pending_snapshot_id::text,
      jsonb_build_object('publicationId',id,'snapshotId',snapshot_id,'pendingSnapshotId',pending_snapshot_id,'at',now())
    FROM publications WHERE id=ANY($1::uuid[]) AND pending_snapshot_id IS NOT NULL ON CONFLICT(key) DO NOTHING`, [ids]);
  await supersedeAttempts(client,ids,'edit');
  await client.query('UPDATE publications SET pending_snapshot_id=NULL,updated_at=now() WHERE id=ANY($1::uuid[])', [ids]);
}

async function invalidateStaleEdits(client: PoolClient, settings: AppSettings, destinationId: string, publicationId?: string, storyIds?: string[]): Promise<void> {
  const invalid = await client.query<{ id: string }>(`SELECT p.id FROM publications p
    LEFT JOIN story_publication_aliases pa ON pa.publication_id=p.id LEFT JOIN story_merges sm ON sm.merged_story_id=p.story_id
    JOIN stories s ON s.id=coalesce(pa.canonical_story_id,sm.canonical_story_id,p.story_id)
    JOIN publication_snapshots desired ON desired.id=coalesce(p.pending_snapshot_id,p.snapshot_id)
    WHERE p.destination_id=$1 AND p.status='published' AND ($5::uuid IS NULL OR p.id=$5)
      AND ($6::uuid[] IS NULL OR s.id=ANY($6))
      AND (p.pending_snapshot_id IS NOT NULL OR EXISTS(SELECT 1 FROM request_attempts a
        WHERE a.publication_id=p.id AND a.operation='edit' AND a.status IN ('running','unknown','retryable')))
      AND ((${eligible}) IS NOT TRUE OR desired.content->>'headline' IS DISTINCT FROM s.headline
        OR desired.content->>'details' IS DISTINCT FROM CASE WHEN s.researched THEN s.summary ELSE s.translated_excerpt END
        OR desired.content->>'score' IS DISTINCT FROM s.interest_score::text
        OR desired.content->>'detailsKind' IS DISTINCT FROM CASE WHEN s.researched THEN 'summary' ELSE 'excerpt' END)
    FOR UPDATE OF p,s`, [destinationId,settings.minimumPublicationScore,settings.profileVersion,settings.modelVersion,publicationId ?? null,storyIds ?? null]);
  // Retention keeps historical outcomes; final admission blocks retries without current provenance.
  await cancelEdits(client,invalid.rows.map(row => row.id));
}

async function pinManualEdit(client: PoolClient, runId: string, publicationId: string, snapshotId: string): Promise<void> {
  const targets = JSON.stringify([{ publicationId, snapshotId }]);
  const saved = await client.query(`UPDATE operational_state SET value=jsonb_set(value,'{editTargets}',
    CASE WHEN coalesce(value->'editTargets','[]'::jsonb) @> $2::jsonb THEN value->'editTargets'
      ELSE coalesce(value->'editTargets','[]'::jsonb)||$2::jsonb END),updated_at=now() WHERE key=$1`,
  [`run_now_publications:${runId}`, targets]);
  if (saved.rowCount !== 1) throw new Error('Manual edit selection is missing');
}

export async function prepareUpdates(settings: AppSettings, destinationId: string, storyIds?: string[],
  options: { cancelOnly?: boolean; runId?: string } = {}): Promise<void> {
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    await invalidateStaleEdits(client,settings,destinationId,undefined,storyIds);
    if (options.cancelOnly) return;
    const rows = await client.query<StoryContent & { publication_id: string; old_content: unknown; pending_content: unknown;
      format_version: number; pending_snapshot_id: string | null; desired_story_id: string | null }>(`SELECT s.*,p.id AS publication_id,
      snap.content AS old_content,desired.content AS pending_content,p.format_version,p.pending_snapshot_id,
      coalesce(desired.story_id,snap.story_id) AS desired_story_id
      FROM (${canonicalPublications}) chosen JOIN stories s ON s.id=chosen.canonical_story_id
      JOIN publications p ON p.id=chosen.id JOIN publication_snapshots snap ON snap.id=p.snapshot_id
      LEFT JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id
      WHERE ${eligible} AND ($5::uuid[] IS NULL OR s.id=ANY($5)) FOR UPDATE OF p,s`,
    [destinationId,settings.minimumPublicationScore,settings.profileVersion,settings.modelVersion,storyIds ?? null]);
    for (const story of rows.rows) {
      if (!await generationIsCurrent(story.id, settings, client.query.bind(client))) {
        await cancelEdits(client,[story.publication_id]);
        continue;
      }
      let content: PublicationSnapshot;
      try { content = await snapshotFor(client,story); render(content); }
      catch (error) {
        if (!(error instanceof PublicationRenderError || error instanceof ZodError)) throw error;
        await cancelEdits(client,[story.publication_id]);
        await client.query(`INSERT INTO request_attempts(publication_id,provider,operation,attempt_number,status,error_code,finished_at)
          SELECT $1,'telegram-bot','prepare_edit',coalesce(max(attempt_number),0)+1,'failed',$2,now()
          FROM request_attempts WHERE publication_id=$1`,
        [story.publication_id,error instanceof PublicationRenderError ? error.code : 'publication_snapshot_invalid']);
        continue;
      }
      const normalized = JSON.stringify(content);
      const previous = publicationSnapshotSchema.safeParse(story.pending_snapshot_id ? story.pending_content : story.old_content);
      if (previous.success && JSON.stringify(previous.data) === normalized && (story.pending_snapshot_id || story.format_version === 1) && story.desired_story_id === story.id) {
        if (options.runId && story.pending_snapshot_id) await pinManualEdit(client, options.runId, story.publication_id, story.pending_snapshot_id);
        continue;
      }
      const snapshot = (await client.query<{ id: string }>(`INSERT INTO publication_snapshots(story_id,content)
        VALUES ($1,$2) RETURNING id`, [story.id,normalized])).rows[0];
      if (!snapshot) throw new Error('Edit snapshot insert failed');
      await cancelEdits(client,[story.publication_id]);
      await client.query('UPDATE publications SET pending_snapshot_id=$1,updated_at=now() WHERE id=$2', [snapshot.id,story.publication_id]);
      if (options.runId) await pinManualEdit(client, options.runId, story.publication_id, snapshot.id);
    }
  });
}

const editDue = `((p.pending_snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM request_attempts a
    WHERE a.publication_id=p.id AND a.operation='edit' AND a.response_metadata->>'snapshotId'=p.pending_snapshot_id::text
      AND (a.status IN ('failed','succeeded') OR a.next_retry_at>now())))
  OR EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit'
    AND a.status IN ('running','unknown','retryable') AND (a.next_retry_at IS NULL OR a.next_retry_at<=now())
    AND a.response_metadata->>'snapshotId'=coalesce(p.pending_snapshot_id,p.snapshot_id)::text))`;

/** Stored edits still require final freshness; unknown outcomes can only be reconciled. */
export async function retryEdits(api: BotApi, settings: AppSettings, destinationId: string, storyIds?: string[]): Promise<number> {
  await transaction(client => invalidateStaleEdits(client,settings,destinationId,undefined,storyIds));
  let edited = 0;
  const botId = String((await api.identity()).id);
  const rows = await db.query<{ id: string }>(`SELECT p.id FROM publications p WHERE p.destination_id=$1 AND p.status='published'
    AND NOT EXISTS(SELECT 1 FROM publication_replacements r WHERE r.duplicate_publication_id=p.id)
    AND NOT EXISTS(SELECT 1 FROM operational_state removed WHERE removed.key='publication_removal:'||p.id::text)
    AND ($2::uuid[] IS NULL OR p.id IN(SELECT chosen.id FROM (${canonicalPublications}) chosen WHERE chosen.canonical_story_id=ANY($2)))
    AND ${editDue} ORDER BY p.created_at`, [destinationId,storyIds ?? null]);
  for (const row of rows.rows) {
    if (await rateLimited()) break;
    await locked(`news-bot-publication:${row.id}`, async client => {
      await transaction(tx => invalidateStaleEdits(tx,settings,destinationId,row.id,storyIds));
      const publication = (await client.query<Publication>(`${publicationEditSelect} WHERE p.id=$1 AND ${editDue}`, [row.id])).rows[0];
      if (publication?.bot_id === botId && await editPublication(publication,api,settings)) edited++;
    });
  }
  return edited;
}
