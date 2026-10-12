import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { evidenceLinkSql } from '../sources/link-policy.js';

const hex = z.string().regex(/^[a-f0-9]{64}$/u);
export const collectedBoundarySchema = z.object({ version:z.literal('collected-owned-content-v1'),inputs:z.array(z.object({
  itemId:z.uuid(),contentHash:z.string().min(1),contentFingerprint:hex,
})).min(1) });
export type CollectedBoundary = z.infer<typeof collectedBoundarySchema>;
export const failureBoundaryFingerprint = (boundary:CollectedBoundary):string=>
  createHash('sha256').update(JSON.stringify(collectedBoundarySchema.parse(boundary))).digest('hex');

/** Baselines observe all owned reports. Admission selects only currently meaningful, valid reports. */
export async function failureInputBoundary(id:string,query=db.query.bind(db),meaningfulOnly=false):Promise<CollectedBoundary> {
  const result = await query(`SELECT item_id,content_hash,normalized_text,bool_and(valid) AS valid,
      (SELECT coalesce(jsonb_agg(link.url ORDER BY link.url),'[]'::jsonb) FROM
        (SELECT DISTINCT l.url FROM item_links l WHERE l.revision_id=owned.revision_id AND l.url ~ '^https?://' AND (NOT $2::boolean OR ${evidenceLinkSql})) link) AS urls
    FROM (SELECT DISTINCT i.id AS item_id,r.id AS revision_id,r.content_hash,r.normalized_text,
      (NOT (r.metadata ? 'pipelineFailure') OR r.metadata->'pipelineFailure'='false'::jsonb)
        AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text) AS valid
    FROM story_mentions m JOIN item_revisions r ON r.id=m.revision_id JOIN source_items i ON i.current_revision_id=r.id
    WHERE m.story_id=$1
    UNION
    SELECT DISTINCT i.id AS item_id,r.id AS revision_id,r.content_hash,r.normalized_text,true AS valid FROM story_link_sources sl
    JOIN item_links l ON l.id=sl.link_id JOIN item_revisions r ON r.id=l.revision_id
    JOIN source_items i ON i.current_revision_id=r.id WHERE sl.story_id=$1 AND (NOT $2::boolean OR (
      sl.classification='relevant' AND ${evidenceLinkSql} AND (NOT (r.metadata ? 'pipelineFailure') OR r.metadata->'pipelineFailure'='false'::jsonb)
      AND NOT EXISTS(SELECT 1 FROM operational_state o WHERE o.key='pipeline_failed_item:'||i.id::text)))
    ) owned GROUP BY item_id,revision_id,content_hash,normalized_text ORDER BY item_id,content_hash,normalized_text`,[id,meaningfulOnly]);
  const rows = z.array(z.object({ item_id:z.uuid(),content_hash:z.string().min(1),
    urls:z.array(z.url()),valid:z.boolean().refine(valid=>!meaningfulOnly || valid),normalized_text:z.string().refine(text=>!meaningfulOnly || text.trim().length>0) })).min(1).parse(result.rows);
  return { version:'collected-owned-content-v1',inputs:rows.flatMap(row=>[{text:row.normalized_text},...row.urls.map(url=>({url}))].map(payload=>({
    itemId:row.item_id,contentHash:row.content_hash,contentFingerprint:createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  }))) };
}
function novelInput(current:CollectedBoundary,baseline:CollectedBoundary):boolean {
  // Revision hashes also include parser metadata. Only owned text/URL payload novelty authorizes work.
  const key=(input:CollectedBoundary['inputs'][number]):string=>`${input.itemId}:${input.contentFingerprint}`;
  const observed=new Set(baseline.inputs.map(key));
  return current.inputs.some(input=>!observed.has(key(input)));
}
export async function failureInputsChanged(id:string,baseline:CollectedBoundary,query=db.query.bind(db)):Promise<boolean> {
  try { return novelInput(await failureInputBoundary(id,query,true),baseline); }
  catch(error) { if(error instanceof z.ZodError) return false; throw error; }
}

/** Only a failed story's automatic retry deadline or exhausted budget can withhold it. */
export async function automaticFailureHeld(id:string,query=db.query.bind(db)):Promise<boolean> {
  const row = (await query<{value:unknown}>('SELECT value FROM operational_state WHERE key=$1',
    [`pipeline_failed_story:${id}`])).rows[0];
  const marker = z.object({ attempts:z.number().int().nonnegative(),next:z.string().nullable(),
    inputBoundary:collectedBoundarySchema.optional() }).safeParse(row?.value);
  if(!marker.success) return false;
  if(marker.data.inputBoundary && await failureInputsChanged(id,marker.data.inputBoundary,query)) return false;
  return !marker.data.next || Date.parse(marker.data.next)>Date.now();
}
