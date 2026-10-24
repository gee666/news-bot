import { transaction } from '../db.js';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import { snapshotHash } from './approval.js';
import { supersedeAttempts } from './store.js';
import { desiredNavigation, delivered, navigationOnlyChange } from './navigation.js';
import { prepareNavigationParts } from './navigation-parts.js';
import { renderStoredPublication } from './message-render.js';
import { PublicationRenderError } from './render.js';
export { latestUpdateTarget } from './navigation.js';
export const markerOnlyChange = navigationOnlyChange;

/** Stage markers, related links and heading cleanup together. Unknown edits retain their attempted snapshot. */
export async function prepareThreadUpdates(destinationId: string, latestPublicationIds?: string[]): Promise<void> {
  if (latestPublicationIds?.length === 0) return;
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    const rows = await client.query<{ id: string; story_id: string | null; destination_id: string; bot_id: string | null;
      content: unknown; pending_content: unknown; pending_snapshot_id: string | null; delivery_kind: 'text' | 'album' }>(`
      SELECT p.id,p.story_id,p.destination_id,p.bot_id,p.delivery_kind,sent.content,
        desired.content AS pending_content,p.pending_snapshot_id FROM publications p
      JOIN publication_snapshots sent ON sent.id=p.snapshot_id
      LEFT JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id
      WHERE p.destination_id=$1 AND ${delivered}
        AND (sent.content ? 'updatedTo' OR sent.content->'sources' @> '[{"previousPublication":true}]'::jsonb
          OR sent.content->'sources' @> '[{"relatedPublication":true}]'::jsonb
          OR (sent.content ? 'earlier' AND NOT sent.content ? 'navigationVersion')
          OR EXISTS(SELECT 1 FROM story_relations r WHERE r.relation IN ('same','related')
            AND (r.lower_story_id=p.story_id OR r.upper_story_id=p.story_id))
          OR EXISTS(SELECT 1 FROM story_publication_threads t WHERE t.classification_version IS NOT NULL
            AND (t.story_id=p.story_id OR t.previous_story_id=p.story_id)))
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit' AND a.status IN ('running','unknown'))
        AND NOT EXISTS(SELECT 1 FROM publication_navigation_parts n WHERE n.publication_id=p.id AND n.status IN ('running','unknown'))
      ORDER BY p.id FOR UPDATE OF p`, [destinationId]);
    for (const row of rows.rows) {
      const sent = publicationSnapshotSchema.parse(row.content);
      const desired = await desiredNavigation(client,row,sent);
      // A first metadata stamp alone is not a reason to edit an unchanged Telegram post.
      if (!sent.earlier && snapshotHash({ ...sent,navigationVersion:undefined }) === snapshotHash({ ...desired,navigationVersion:undefined })) continue;
      const pending = publicationSnapshotSchema.safeParse(row.pending_content);
      if (pending.success && !navigationOnlyChange(sent,pending.data)) continue;
      if (pending.success && snapshotHash(pending.data) === snapshotHash(desired)) continue;
      let content: PublicationSnapshot = desired;
      try { await renderStoredPublication(client,row.id,content,row.delivery_kind); }
      catch (error) {
        if (!(error instanceof PublicationRenderError)) throw error;
        if (!['publication_message_too_long','publication_entity_limit','publication_text_requires_new_edition'].includes(error.code)) throw error;
        content = { ...desired,navigationOverflow:true };
        await renderStoredPublication(client,row.id,content,row.delivery_kind);
      }
      if (snapshotHash(sent)===snapshotHash(content) || pending.success && snapshotHash(pending.data)===snapshotHash(content)) continue;
      const snapshot = (await client.query<{ id: string }>(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
        [row.story_id,JSON.stringify(content)])).rows[0];
      if (!snapshot) throw new Error('Navigation snapshot insert failed');
      await supersedeAttempts(client,[row.id],'edit');
      await client.query('UPDATE publications SET pending_snapshot_id=$2,updated_at=now() WHERE id=$1', [row.id,snapshot.id]);
      await prepareNavigationParts(client,row.id,snapshot.id,content);
    }
  });
}
