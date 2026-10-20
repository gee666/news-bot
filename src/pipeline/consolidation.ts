import { z } from 'zod';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { eventInput } from './consolidation-input.js';
import { mergeStories } from './consolidation-store.js';
import { retainedStories } from './matching.js';
import { groupReport, GROUPING_VERSION } from './grouping-model.js';
import { publishedStory, unpublished } from './generation-store.js';
import { stage } from './state.js';
import { existingItemFailures, itemWork } from './item-failures.js';

/** Finish old associated intake with exactly the same grouping rule as new mentions. */
export async function consolidateStories(settings: AppSettings, batchId: string): Promise<void> {
  const rows = await db.query<{ revision_id: string; item_id: string; original_text: string; urls: string[] }>(`
    SELECT r.id AS revision_id,r.item_id,r.original_text,
      ARRAY(SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=r.id ORDER BY l.url) AS urls
    FROM batch_items b JOIN item_revisions r ON r.id=b.revision_id JOIN source_items i ON i.current_revision_id=r.id
    WHERE b.batch_id=$1 AND b.status<>'failed' AND NOT EXISTS(
      SELECT 1 FROM consolidation_intake done WHERE done.revision_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM story_mentions m WHERE m.revision_id=r.id AND m.story_id IS NULL
      AND m.metadata->>'disposition' IS DISTINCT FROM 'outside_collection_window')
    ORDER BY b.created_at,r.id`, [batchId]);
  const failed = await existingItemFailures(batchId);
  for (const revision of rows.rows) await itemWork(batchId, revision.revision_id, failed, async () => {
    await stage(batchId, { revisionId: revision.revision_id }, `consolidate:${GROUPING_VERSION}`, settings, z.boolean(), async context => {
      const owned = await db.query<{ story_id: string }>('SELECT DISTINCT story_id FROM story_mentions WHERE revision_id=$1 AND story_id IS NOT NULL', [revision.revision_id]);
      for (const owner of owned.rows) {
        if (await publishedStory(owner.story_id)) continue;
        let incoming = await eventInput(owner.story_id);
        if (!incoming) continue;
        const candidates = (await retainedStories(settings)).filter(story => story.id!==incoming?.id);
        const draftRows = await db.query<{ id: string }>(`SELECT id FROM stories WHERE id=ANY($1::uuid[]) AND ${unpublished('stories')}`,
          [candidates.map(candidate => candidate.id)]);
        const draftIds = new Set(draftRows.rows.map(row => row.id));
        const drafts = candidates.filter(candidate => draftIds.has(candidate.id));
        const matches = await groupReport(incoming, drafts, settings, { ...context,storyId:owner.story_id });
        for (const match of matches) {
          const right = drafts.find(story => story.id===match.storyId);
          if (!right) throw new Error('Grouping target changed');
          const merged = await mergeStories(incoming,right,'update');
          if (!merged) throw new Error('Grouping target changed');
          const current = await eventInput(merged.canonicalId);
          if (!current) throw new Error('Merged story has no reports');
          incoming = current;
        }
      }
      await db.query(`INSERT INTO consolidation_intake(revision_id,item_id,text_fingerprint,urls)
        VALUES($1,$2,encode(sha256(convert_to($3,'UTF8')),'hex'),$4) ON CONFLICT(revision_id) DO NOTHING`,
        [revision.revision_id,revision.item_id,revision.original_text,revision.urls]);
      return true;
    });
  });
}
