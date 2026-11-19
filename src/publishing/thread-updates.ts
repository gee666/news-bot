import { prepareReplacements } from './replacements.js';
import { transaction } from '../db.js';
import { publicationSnapshotSchema, type PublicationSnapshot } from '../types.js';
import { supersedeAttempts, type Publication } from './store.js';
import { desiredNavigation, delivered, navigationOnlyChange } from './navigation.js';
import { renderPublication, PublicationRenderError } from './render.js';
import { fanOutNavigation, hasThreadEvents, takeNavigationEvents } from './thread-events.js';
export { latestUpdateTarget } from './navigation.js';
export const markerOnlyChange = navigationOnlyChange;

/** Stage deletions before related-link repairs. Unknown edits retain their attempted snapshot. */
export async function prepareThreadUpdates(destinationId: string, latestPublicationIds?: string[]): Promise<void> {
  if (latestPublicationIds?.length === 0 || !await hasThreadEvents(destinationId,latestPublicationIds)) return;
  await transaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('news-bot-history'))");
    await prepareReplacements(client,destinationId,latestPublicationIds);
    await fanOutNavigation(client);
    const ids = await takeNavigationEvents(client,destinationId);
    if (!ids.length) return;
    const rows = await client.query<{ id: string; story_id: string | null; destination_id: string; bot_id: string | null;
      content: unknown; pending_content: unknown; pending_snapshot_id: string | null; delivery_kind: Publication['delivery_kind'] }>(`
      SELECT p.id,p.story_id,p.destination_id,p.bot_id,p.delivery_kind,sent.content,
        desired.content AS pending_content,p.pending_snapshot_id FROM publications p
      JOIN publication_snapshots sent ON sent.id=p.snapshot_id
      LEFT JOIN publication_snapshots desired ON desired.id=p.pending_snapshot_id
      WHERE p.destination_id=$1 AND p.id=ANY($2::uuid[]) AND ${delivered}
        AND NOT EXISTS(SELECT 1 FROM request_attempts a WHERE a.publication_id=p.id AND a.operation='edit' AND a.status IN ('running','unknown'))
      ORDER BY p.id FOR UPDATE OF p`, [destinationId,ids]);
    for (const row of rows.rows) {
      const sent = publicationSnapshotSchema.parse(row.content);
      // Match the schema's property order on both sides, including rebuilt related links.
      const desired = publicationSnapshotSchema.parse(await desiredNavigation(client,row,sent));
      const refreshLegacyNavigation = sent.navigationVersion !== 2
        && sent.sources.some(source => source.unverifiedPublication || source.relatedPublication);
      const pending = publicationSnapshotSchema.safeParse(row.pending_content);
      if (pending.success && !navigationOnlyChange(sent,pending.data)) continue;
      if (!refreshLegacyNavigation && JSON.stringify({ ...sent,navigationVersion:undefined })
        === JSON.stringify({ ...desired,navigationVersion:undefined })) {
        // The graph may revert while a link-only edit is still waiting to send.
        if (pending.success) {
          await supersedeAttempts(client,[row.id],'edit');
          await client.query('UPDATE publications SET pending_snapshot_id=NULL,updated_at=now() WHERE id=$1',[row.id]);
        }
        continue;
      }
      if (pending.success && JSON.stringify(pending.data) === JSON.stringify(desired)) continue;
      const content: PublicationSnapshot = desired;
      if ((await client.query(`SELECT 1 FROM operational_state o JOIN publication_snapshots snap ON snap.id::text=o.value->>'snapshotId'
        WHERE (o.key=$1 OR o.key LIKE $1||':%') AND snap.content=$2::jsonb`, [`publication_edit_settled:${row.id}`,JSON.stringify(content)])).rows.length) continue;
      try { renderPublication({content,delivery_kind:row.delivery_kind ?? 'text'}); }
      catch (error) {
        if (!(error instanceof PublicationRenderError)) throw error;
        if (!['publication_message_too_long','publication_entity_limit'].includes(error.code)) throw error;
        // Keep the sent snapshot intact. A link-only reply is not a publication.
        await client.query(`UPDATE publications SET error_code='publication_navigation_requires_new_edition',updated_at=now() WHERE id=$1`,[row.id]);
        continue;
      }
      if (JSON.stringify(sent)===JSON.stringify(content) || pending.success && JSON.stringify(pending.data)===JSON.stringify(content)) continue;
      const snapshot = (await client.query<{ id: string }>(`INSERT INTO publication_snapshots(story_id,content) VALUES($1,$2) RETURNING id`,
        [row.story_id,JSON.stringify(content)])).rows[0];
      if (!snapshot) throw new Error('Navigation snapshot insert failed');
      await supersedeAttempts(client,[row.id],'edit');
      await client.query('UPDATE publications SET pending_snapshot_id=$2,updated_at=now() WHERE id=$1', [row.id,snapshot.id]);
    }
  });
}
