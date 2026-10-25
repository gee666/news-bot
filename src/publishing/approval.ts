import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { publicationSnapshotSchema } from '../types.js';
import { renderFullText, renderedMessageSchema } from './full-text.js';
import { CAPTION_LIMIT } from './caption.js';
import { visibleSources } from './sources.js';
import type { Publication } from './store.js';

const actionBase = z.object({
  approvalId: z.uuid(), state: z.enum(['approved','running','completed','uncertain','failed']),
  publicationId:z.uuid(),destinationId:z.string().regex(/^-100\d+$/u),
  messageId:z.string().regex(/^\d+$/u),priorSnapshotId:z.uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u), storyId: z.uuid(), contentVersion: z.number().int().positive(),
  expiresAt:z.iso.datetime(),coordinator:z.string().min(1),
});
export const actionSchema=z.discriminatedUnion('operation',[
  actionBase.extend({operation:z.literal('edit'),desiredSnapshotId:z.uuid(),receiptId:z.uuid().nullable(),
    fullContentRepair:z.object({ priorSnapshotHash:z.string().regex(/^[a-f0-9]{64}$/u),
      botId:z.string().regex(/^\d+$/u),mediaSnapshotId:z.uuid().nullable(),reason:z.string().trim().min(1),
      reviewedCaption:z.object({snapshot:publicationSnapshotSchema,snapshotHash:z.string().regex(/^[a-f0-9]{64}$/u)}).optional(),
    }).optional(),
  }).refine(action => action.receiptId !== null || !!action.fullContentRepair, 'Generation receipt required outside reviewed full repair'),
  actionBase.extend({operation:z.literal('delete'),desiredSnapshotId:z.null(),receiptId:z.null()}),
]);
export type ReviewedAction = z.infer<typeof actionSchema>;
export interface DeliveryAuthorization { approvalId?: string; verificationTest?: boolean; fullContentRepair?: boolean; fullRepairPlanHash?: string; navigationSlot?: string }
export const fullRepairPlanHash = (parts: unknown): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const actionKey = (id: string): string => `publication_action:${id}`;
export function snapshotHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(publicationSnapshotSchema.parse(content))).digest('hex');
}
/** Lossless limit-based split, or an explicitly reviewed overview plus the entire original body. */
export function fullRepairPlan(content: unknown, reviewedCaption?: { snapshot: unknown; snapshotHash:string }) {
  const snapshot = publicationSnapshotSchema.parse(content);
  let parts = renderFullText(snapshot,false,CAPTION_LIMIT);
  if (reviewedCaption) {
    if (snapshotHash(reviewedCaption.snapshot) !== reviewedCaption.snapshotHash) throw new Error('publication_full_repair_caption_changed');
    const caption = renderFullText(reviewedCaption.snapshot,false,CAPTION_LIMIT);
    const captionUrls = new Set(caption[0]?.links.map(link => link.url));
    if (caption.length !== 1 || snapshot.sources.some(source => !source.unverifiedPublication && !source.previousPublication && !source.relatedPublication && !captionUrls.has(source.url)))
      throw new Error('publication_full_repair_caption_incomplete');
    parts = [...caption,...renderFullText(snapshot)];
  }
  const deliveredUrls = new Set(parts.flatMap(part => part.links.map(link => link.url)));
  if (visibleSources(snapshot.sources).some(source => !source.unverifiedPublication && !deliveredUrls.has(source.url))) throw new Error('publication_full_repair_sources_not_rendered');
  return parts;
}

/** A successful reviewed caption edit authorizes only its exact frozen continuation plan. */
export async function fullRepairContinuation(client: Pick<PoolClient,'query'>, publication: Publication): Promise<string | null> {
  if (publication.delivery_kind !== 'album' || publication.pending_snapshot_id) return null;
  const attempt = (await client.query<{ response_metadata: { approvalId?: string } }>(`SELECT response_metadata FROM request_attempts
    WHERE publication_id=$1 AND operation='edit' AND status='succeeded' AND response_metadata->>'fullContentRepair'='true'
      AND response_metadata->>'snapshotId'=$2 ORDER BY dispatched_at DESC,id DESC LIMIT 1`,[publication.id,publication.snapshot_id])).rows[0];
  const action = attempt?.response_metadata.approvalId ? await loadAction(client,attempt.response_metadata.approvalId) : null;
  if (!action || action.operation !== 'edit' || !action.fullContentRepair || !['running','completed'].includes(action.state)
    || action.publicationId !== publication.id || action.destinationId !== publication.destination_id || action.messageId !== publication.message_id
    || action.desiredSnapshotId !== publication.snapshot_id || action.snapshotHash !== snapshotHash(publication.content)
    || action.fullContentRepair.botId !== publication.bot_id || action.fullContentRepair.mediaSnapshotId !== (publication.media_snapshot_id ?? null)) return null;
  const prior = (await client.query<{ content: unknown }>('SELECT content FROM publication_snapshots WHERE id=$1',[action.priorSnapshotId])).rows[0];
  if (!prior || snapshotHash(prior.content) !== action.fullContentRepair.priorSnapshotHash) return null;
  const parts = (await client.query<{ content: unknown; snapshot_id: string; part_number:number }>(`SELECT content,snapshot_id,part_number
    FROM publication_text_parts WHERE publication_id=$1 ORDER BY part_number`,[publication.id])).rows;
  const expected = fullRepairPlan(publication.content,action.fullContentRepair.reviewedCaption);
  if (parts.length !== expected.length || parts.some((part,index) => part.part_number !== index || part.snapshot_id !== action.desiredSnapshotId
    || JSON.stringify(renderedMessageSchema.parse(part.content)) !== JSON.stringify(expected[index]))) return null;
  return action.approvalId;
}

export async function loadAction(client: Pick<PoolClient,'query'>, id: string): Promise<ReviewedAction | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const parsed = actionSchema.safeParse((await client.query<{ value: unknown }>(
    'SELECT value FROM operational_state WHERE key=$1 FOR SHARE', [actionKey(id)])).rows[0]?.value);
  return parsed.success && parsed.data.approvalId === id ? parsed.data : null;
}
