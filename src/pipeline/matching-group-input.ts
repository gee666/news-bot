import type { PoolClient } from 'pg';
import { db } from '../db.js';
import type { AppSettings } from '../settings.js';
import { eventInput, type EventInput } from './consolidation-input.js';
import { matchingRepresentatives } from './matching-representatives.js';
import { hash } from './state.js';

export interface GroupEventInput extends EventInput { storyIds: string[]; retentionDays: number }
interface GroupReportRow {
  id: string; story_id: string; revision_id: string; text: string; source_url: string | null;
  links: string[]; published_at: Date | null; story_ids: string[];
}

export function isGroupEventInput(input: EventInput): input is GroupEventInput {
  return 'storyIds' in input && 'retentionDays' in input;
}
export function matchingInputStoryIds(input: EventInput): string[] {
  return isGroupEventInput(input) ? input.storyIds : [input.id];
}

/** Current retained source reports across the entire trusted identity component.
 * Keep the requested owner ID so callers can validate and attach to that owner.
 * Publication branches contribute reports, never generated publication summaries.
 */
export async function groupEventInput(id: string, settings: Pick<AppSettings, 'retentionDays'>,
  client: Pick<PoolClient, 'query'> = db): Promise<GroupEventInput | null> {
  const result = await client.query<GroupReportRow>(`WITH RECURSIVE
    matching_roots AS (SELECT $1::uuid AS id), matching_eligible AS (SELECT id FROM matching_roots),
    ${matchingRepresentatives}
    SELECT m.id,m.story_id,m.revision_id,m.text,i.original_url AS source_url,i.published_at,
      ARRAY(SELECT DISTINCT l.url FROM mention_links ml JOIN item_links l ON l.id=ml.link_id
        WHERE ml.mention_id=m.id AND ml.classification='relevant' ORDER BY l.url) AS links,
      ARRAY(SELECT id FROM matching_components ORDER BY id) AS story_ids
    FROM matching_components component JOIN stories s ON s.id=component.id
    JOIN story_mentions m ON m.story_id=s.id JOIN item_revisions r ON r.id=m.revision_id
    JOIN source_items i ON i.current_revision_id=r.id
    WHERE s.status<>'rejected' AND NOT EXISTS(SELECT 1 FROM story_merges sm WHERE sm.merged_story_id=s.id)
      AND i.retention_at>=now()-$2*interval '1 day'
    ORDER BY s.created_at,s.id,m.created_at,m.id`, [id, settings.retentionDays]);
  if (!result.rows.length) return null;
  const storyIds = result.rows[0]?.story_ids ?? [];
  return { id, storyIds, retentionDays: settings.retentionDays,
    text: [...new Set(result.rows.map(row => row.text))].join('\n\n'),
    fingerprint: hash({ storyIds, rows: result.rows }),
    reports: result.rows.map(row => ({ text: row.text, sourceUrl: row.source_url, links: row.links,
      publishedAt: row.published_at?.toISOString() ?? null })) };
}

/** Revalidate the same evidence scope used by the classifier. */
export async function currentMatchingInput(input: EventInput, client: Pick<PoolClient, 'query'> = db): Promise<EventInput | null> {
  if (isGroupEventInput(input)) return groupEventInput(input.id, input, client);
  return eventInput(input.id, client);
}
