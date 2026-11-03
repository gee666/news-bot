import { z } from 'zod';
import { db } from '../db.js';
import { generationThread } from '../pipeline/generation-context.js';
import { readFailure } from '../sources/read-quality.js';

export const primaryEventDateSchema = z.object({ evidenceId: z.uuid(), url: z.url(),
  publishedAt: z.iso.datetime().nullable() }).strict();
export type PrimaryEventDate = z.infer<typeof primaryEventDateSchema>;
const readSchema = z.object({ id: z.uuid(), url: z.url(), title: z.string().nullable(), content: z.string(), metadata: z.unknown() });
const dateMetadataSchema = z.object({ publishedAt: z.iso.datetime({ offset: true }).nullish() });

/** Informational only. Observe dates from already-read event primaries, never discovery links or fetched/updated times.
 * Include undated reads explicitly so a later attachment cannot replace preparation provenance. */
export async function primaryEventDates(storyId: string, query = db.query.bind(db)): Promise<PrimaryEventDate[]> {
  const result = await query(`${generationThread} SELECT DISTINCT e.id,coalesce(e.canonical_url,e.url) AS url,e.title,e.content,e.metadata
    FROM story_evidence se JOIN evidence_documents e ON e.id=se.evidence_id
    WHERE se.story_id IN(SELECT id FROM generation_story_ids) AND se.superseded_at IS NULL
      AND se.role='primary' AND se.relevance='relevant' AND se.verified_at IS NOT NULL
      AND e.access='public' AND length(trim(e.content))>0 ORDER BY e.id`, [storyId]);
  return z.array(readSchema).parse(result.rows).flatMap(row => {
    if (readFailure(row.title, row.content, row.url, row.metadata)) return [];
    const metadata = dateMetadataSchema.safeParse(row.metadata);
    const date = metadata.success ? metadata.data.publishedAt : null;
    return [{ evidenceId: row.id, url: row.url, publishedAt: date ? new Date(date).toISOString() : null }];
  });
}
