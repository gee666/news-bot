import { unpublished } from './generation-store.js';
import { z } from 'zod';
import { db, transaction } from '../db.js';
import { reconcileStory } from './revisions.js';

export const EXTRACTION_VERSION = 'events-v6';
const spanSchema = z.object({ start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict();
export const spansSchema = z.array(spanSchema);
export type Span = z.infer<typeof spanSchema>;
export const eventsSchema = z.array(z.object({ parts: spansSchema.min(1), context: spansSchema }).strict());
export type ExtractedEvent = z.infer<typeof eventsSchema>[number];
export function eventSpans(event: ExtractedEvent): Span[] { return [...event.context, ...event.parts].sort((a, b) => a.start - b.start); }
export function eventText(text: string, event: ExtractedEvent): string { return eventSpans(event).map(span => text.slice(span.start, span.end)).join('\n\n'); }
export function validSpans(text: string, spans: readonly Span[]): boolean {
  let last = 0;
  return spans.every(span => {
    const valid = span.start >= last && span.end > span.start && span.end <= text.length && !!text.slice(span.start, span.end).trim();
    last = span.end;
    return valid;
  });
}

/** Extraction belongs to immutable revision content, not to the current interest/model settings. */
export async function committedExtraction(revisionId: string): Promise<ExtractedEvent[] | null> {
  const saved = await db.query<{ spans: unknown }>(`SELECT spans FROM (
    SELECT metadata->'pipelineExtraction' AS spans,0 AS priority,NULL::timestamptz AS completed_at
      FROM item_revisions WHERE id=$1 AND metadata ? 'pipelineExtraction'
    UNION ALL SELECT output,1,completed_at FROM stage_state WHERE revision_id=$1
      AND stage LIKE 'extract:%' AND status='completed'
    ) receipts ORDER BY priority,completed_at DESC NULLS LAST`, [revisionId]);
  for (const row of saved.rows) {
    const events = eventsSchema.safeParse(row.spans);
    if (events.success) return events.data;
    const spans = spansSchema.safeParse(row.spans);
    if (spans.success) return spans.data.map(span => ({ parts: [span], context: [] }));
  }
  return null;
}

export async function applyExtraction(batchId: string, revisionId: string, text: string, input: (Span | ExtractedEvent)[]): Promise<void> {
  const events = eventsSchema.parse(input.map(value => 'parts' in value ? value : { parts: [value], context: [] }));
  if (!events.every(event => validSpans(text, eventSpans(event)))
    || !validSpans(text, events.flatMap(event => event.parts).sort((a, b) => a.start - b.start))) throw new Error('Invalid extraction spans');
  const expected = events.map(event => { const spans = eventSpans(event); return { text: eventText(text, event),
    start: spans.length === 1 ? spans[0]?.start ?? null : null, end: spans.length === 1 ? spans[0]?.end ?? null : null, event }; });
  await transaction(async client => {
    await client.query('SELECT id FROM item_revisions WHERE id=$1 FOR UPDATE', [revisionId]);
    const existing = await client.query<{ text: string; start_offset: number | null; end_offset: number | null; story_id: string | null }>(
      'SELECT text,start_offset,end_offset,story_id FROM story_mentions WHERE revision_id=$1 ORDER BY ordinal', [revisionId]);
    const same = existing.rows.length === expected.length && existing.rows.every((row, index) => {
      const value = expected[index];
      return value && row.start_offset === value.start && row.end_offset === value.end && row.text === value.text;
    });
    if (!same) {
      const affected = [...new Set(existing.rows.flatMap(row => row.story_id ? [row.story_id] : []))];
      for (const storyId of affected) {
        await client.query(`INSERT INTO stage_state(batch_id,story_id,stage,status,output) VALUES($1,$2,'extraction_affected','skipped',$3)
          ON CONFLICT(batch_id,revision_id,story_id,stage) DO UPDATE SET output=EXCLUDED.output`,
        [batchId, storyId, JSON.stringify({ revisionId, previousText: existing.rows.filter(row => row.story_id === storyId).map(row => row.text).join('\n\n') })]);
        await client.query(`UPDATE stories SET status='processing',interest_stale=true WHERE id=$1 AND ${unpublished('stories')}`, [storyId]);
      }
      await client.query('DELETE FROM story_mentions WHERE revision_id=$1', [revisionId]);
      await client.query(`UPDATE stage_state SET status='pending',output=NULL,completed_at=NULL
        WHERE batch_id=$1 AND revision_id=$2 AND stage LIKE 'links:%' AND status='completed'`, [batchId, revisionId]);
      for (const [ordinal, value] of expected.entries()) await client.query(`INSERT INTO story_mentions(revision_id,text,start_offset,end_offset,ordinal,metadata)
        VALUES($1,$2,$3,$4,$5,$6)`, [revisionId, value.text, value.start, value.end, ordinal,
        JSON.stringify({ sourceSpans: value.event.parts, contextSpans: value.event.context, extractionVersion: EXTRACTION_VERSION })]);
      for (const storyId of affected) await reconcileStory(client, storyId);
    }
    if (same) for (const [ordinal, value] of expected.entries()) await client.query(`UPDATE story_mentions SET metadata=metadata || $3::jsonb
      WHERE revision_id=$1 AND ordinal=$2`, [revisionId, ordinal,
      JSON.stringify({ sourceSpans: value.event.parts, contextSpans: value.event.context, extractionVersion: EXTRACTION_VERSION })]);
    await client.query(`UPDATE item_revisions SET metadata=metadata || jsonb_build_object(
      'pipelineExtraction',$2::jsonb,'pipelineExtractionVersion',$3::text,'pipelineExtractionBatchId',$4::text) WHERE id=$1`,
      [revisionId, JSON.stringify(events), EXTRACTION_VERSION, batchId]);
    await client.query(`UPDATE batch_items SET status=CASE WHEN status='completed' AND $4::boolean THEN status ELSE $3 END
      WHERE batch_id=$1 AND revision_id=$2`,
      [batchId, revisionId, events.length ? 'processing' : 'rejected', same && events.length>0]);
  });
}
