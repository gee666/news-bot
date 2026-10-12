import type { PoolClient } from 'pg';
import { db } from '../db.js';
import { hash } from './state.js';

export interface EventReport { text: string; sourceUrl: string | null; links: string[] }
export interface EventInput { id: string; text: string; fingerprint: string; reports: EventReport[] }
interface ReportRow { id: string; revision_id: string; text: string; source_url: string | null; links: string[] }
const reportColumns = `m.id,m.revision_id,m.text,i.original_url AS source_url,
  ARRAY(SELECT DISTINCT l.url FROM mention_links ml JOIN item_links l ON l.id=ml.link_id
    WHERE ml.mention_id=m.id AND ml.classification='relevant' ORDER BY l.url) AS links`;
function input(id: string, rows: ReportRow[]): EventInput | null {
  return rows.length ? { id, text: [...new Set(rows.map(row => row.text))].join('\n\n'), fingerprint: hash(rows),
    reports: rows.map(row => ({ text: row.text, sourceUrl: row.source_url, links: row.links })) } : null;
}

/** Metadata-created IDs and report order are not new collected evidence. Keep all
 * text/provenance/link payloads, including repeated reports, in a stable selection key. */
export function eventSemanticHash(...stories: EventInput[]): string {
  return hash(stories.map(story=>({ id: story.id,reports: story.reports.map(report=>({ ...report,links: [...report.links].sort() }))
    .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) })).sort((a,b)=>a.id.localeCompare(b.id)));
}

/** URLs describe the reported distribution; shared names or source URLs alone never establish identity. */
export function eventDecisionInput(left: EventInput, right: EventInput) {
  return { ...eventComparison(left.text, right.text),
    reportGroups: [left.reports, right.reports].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}
export async function mentionInput(id: string, client: Pick<PoolClient, 'query'> = db): Promise<EventInput | null> {
  const mentions = await client.query<ReportRow>(`SELECT ${reportColumns} FROM story_mentions m
    JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id WHERE m.id=$1`, [id]);
  return input(id, mentions.rows);
}

/** The shorter report is the query, the fuller group its context, independent of arrival order. */
export function eventComparison(left: string, right: string): { mention: string; candidate: string } {
  const [mention = '', candidate = ''] = [left, right].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return { mention, candidate };
}

/** Keep every current claim, including uncertainty. A representative is display text, not event identity. */
export async function eventInput(id: string, client: Pick<PoolClient, 'query'> = db): Promise<EventInput | null> {
  const mentions = await client.query<ReportRow>(`SELECT ${reportColumns}
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
    WHERE m.story_id=$1 ORDER BY m.created_at,m.id`, [id]);
  return input(id, mentions.rows);
}
