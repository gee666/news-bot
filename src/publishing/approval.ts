import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { publicationSnapshotSchema } from '../types.js';

const actionBase = z.object({
  approvalId: z.uuid(), state: z.enum(['approved','running','completed','uncertain','failed']),
  publicationId:z.uuid(),destinationId:z.string().regex(/^-100\d+$/u),
  messageId:z.string().regex(/^\d+$/u),priorSnapshotId:z.uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u), storyId: z.uuid(), contentVersion: z.number().int().positive(),
  expiresAt:z.iso.datetime(),coordinator:z.string().min(1),
});
export const actionSchema=z.discriminatedUnion('operation',[
  actionBase.extend({operation:z.literal('edit'),desiredSnapshotId:z.uuid(),receiptId:z.uuid()}),
  actionBase.extend({operation:z.literal('delete'),desiredSnapshotId:z.null(),receiptId:z.null()}),
]);
export type ReviewedAction = z.infer<typeof actionSchema>;
export interface DeliveryAuthorization { approvalId?: string; verificationTest?: boolean }
export const actionKey = (id: string): string => `publication_action:${id}`;
export function snapshotHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(publicationSnapshotSchema.parse(content))).digest('hex');
}
export async function loadAction(client: Pick<PoolClient,'query'>, id: string): Promise<ReviewedAction | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const parsed = actionSchema.safeParse((await client.query<{ value: unknown }>(
    'SELECT value FROM operational_state WHERE key=$1 FOR SHARE', [actionKey(id)])).rows[0]?.value);
  return parsed.success && parsed.data.approvalId === id ? parsed.data : null;
}
