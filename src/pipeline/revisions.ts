import { unpublished } from './generation-store.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { db, transaction } from '../db.js';
import type { AppSettings } from '../settings.js';
import { hash, stage } from './state.js';
import { blockedStoriesCte, existingItemFailures, itemWork } from './item-failures.js';

export function meaningfulFingerprint(texts: readonly string[], links: readonly { url: string; classification: string; anchor_text: string | null }[]): string {
  return hash({ texts, links: links.filter(link => link.classification !== 'irrelevant')
    .map(link => [link.url, link.classification, link.anchor_text]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}

/** Reconcile current evidence, including reactivation of an older saved revision. */
export async function reconcileStory(client: Pick<PoolClient, 'query'>, storyId: string): Promise<void> {
  const story = await client.query<{ status: string }>(`WITH RECURSIVE ${blockedStoriesCte}
    SELECT status FROM stories WHERE id=$1 AND ${unpublished('stories')} AND id::text NOT IN(SELECT id FROM blocked_stories) FOR UPDATE`, [storyId]);
  if (!story.rows.length) return;
  const current = await client.query<{ text: string }>(`SELECT m.text FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE m.story_id=$1 ORDER BY m.id`, [storyId]);
  if (!current.rows.length) {
    await client.query("UPDATE stories SET status='rejected',interest_stale=true,updated_at=now() WHERE id=$1", [storyId]);
    await client.query('UPDATE story_evidence SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL', [storyId]);
    await client.query('DELETE FROM operational_state WHERE key=$1', [`digest_refresh:${storyId}`]);
    return;
  }
  // Same-event coverage must not regenerate already completed displays. Edits are hidden by the collector trigger.
  if (story.rows[0]?.status === 'completed') return;
  const links = await client.query<{ url: string; classification: string; anchor_text: string | null }>(`SELECT DISTINCT l.url,ml.classification,l.anchor_text
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
    JOIN mention_links ml ON ml.mention_id=m.id JOIN item_links l ON l.id=ml.link_id
    WHERE m.story_id=$1 AND ml.classification<>'irrelevant'`, [storyId]);
  const fingerprint = meaningfulFingerprint(current.rows.map(m => m.text), links.rows);
  const changed = await client.query(`UPDATE stories SET status='processing',content_version=content_version+1,meaningful_hash=$2,
    headline=NULL,summary=NULL,translated_excerpt=NULL,researched=false,interest_stale=true,updated_at=now()
    WHERE id=$1 AND (meaningful_hash IS DISTINCT FROM $2 OR status='rejected') RETURNING id`, [storyId, fingerprint]);
  if (changed.rows.length) await client.query('UPDATE story_evidence SET superseded_at=now() WHERE story_id=$1 AND superseded_at IS NULL', [storyId]);
}

export async function reconcileEdits(batchId: string, settings: AppSettings, revisionIds?: readonly string[]): Promise<void> {
  const revisions = await db.query<{ id: string; item_id: string }>(`SELECT r.id,r.item_id FROM batch_items b
    JOIN item_revisions r ON r.id=b.revision_id WHERE b.batch_id=$1
      AND ($2::uuid[] IS NULL OR r.id=ANY($2)) ORDER BY r.id`, [batchId, revisionIds ?? null]);
  const failed = await existingItemFailures(batchId);
  for (const revision of revisions.rows) await itemWork(batchId, revision.id, failed, async () => {
    await stage(batchId, { revisionId: revision.id }, 'reconcile_edit', settings, z.boolean(), async () => {
      await transaction(async client => {
        const stories = await client.query<{ id: string }>(`SELECT DISTINCT m.story_id AS id FROM story_mentions m
          JOIN item_revisions r ON r.id=m.revision_id WHERE r.item_id=$1 AND m.story_id IS NOT NULL
          UNION SELECT story_id AS id FROM stage_state WHERE batch_id=$2 AND stage='extraction_affected' AND story_id IS NOT NULL`,
        [revision.item_id, batchId]);
        for (const story of stories.rows) await reconcileStory(client, story.id);
      });
      return true;
    });
  });
}
