import { z } from 'zod';

const text = z.string();
const timestamp = z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.iso.datetime());
export const publicSourceSchema = z.object({
  id: z.uuid(), name: text, externalId: text, access: z.enum(['public', 'restricted', 'unknown']), enabled: z.boolean(), active: z.boolean(),
});
export const publicLoginSchema = z.object({
  provider: z.literal('openai-codex'), connected: z.boolean(),
  login: z.object({ id: z.uuid(), phase: z.enum(['starting', 'awaiting_redirect', 'exchanging', 'complete', 'failed', 'cancelled']),
    expiresAt: timestamp,
    authorizationUrl: z.url().refine(value => {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    }).optional(),
    message: text.optional(),
  }).nullable(),
});
const count = z.number().int().nonnegative();
export const batchItemCountsSchema = z.object({ total: count, completed: count, rejected: count, failed: count, pending: count })
  .refine(value => value.total === value.completed + value.rejected + value.failed + value.pending, 'Item counts must sum to total');
const batchStatus = z.enum(['queued', 'collecting', 'processing', 'waiting', 'completed', 'failed']);
export const publicationAdmissionDenialSchema = z.object({
  publicationId: z.uuid(), snapshotId: z.uuid(), operation: z.enum(['send', 'edit']).nullable(),
  reason: z.enum(['settings_changed', 'publishing_paused', 'snapshot_changed', 'story_ineligible',
    'retained_provenance_unknown', 'current_generation_missing', 'source_quality_changed',
    'delivery_outcome_unknown', 'approval_invalid', 'publication_removed', 'telegram_cooldown', 'consolidation_unresolved']),
  lastSeenAt: timestamp, occurrences: count.positive(),
});
export const publicStatusSchema = z.object({
  batches: z.array(z.object({ id: z.uuid(), status: batchStatus, started_at: timestamp, completed_at: timestamp.nullable(),
    next_retry_at: timestamp.nullable(), waiting_reason: text.nullable(), error_code: text.nullable(), item_counts: batchItemCountsSchema,
    source_counts: z.object({ total: count, completed: count, failed: count, pending: count }).optional(),
    source_failures: z.array(z.object({ sourceId: z.uuid(), code: text.nullable() })).optional() })),
  digestRecovery: z.object({ phase: z.enum(['running','waiting','failed','completed']),
    code: text.nullable(), next_retry_at: timestamp.nullable() }).nullable().optional(),

  waits: z.array(z.object({ batch_id: z.uuid(), batch_status: batchStatus,
    batch_completed_at: timestamp.nullable(), batch_error_code: text.nullable(),
    stage: text, status: text, next_retry_at: timestamp.nullable(), waiting_reason: text.nullable(), error_code: text.nullable(), count })),
  embeddings: z.array(z.object({ model: text, dimensions: z.number().int(), input_version: text, status: text })),
  publications: z.array(z.object({ status: text, count: z.number().int() })),
  readyPublications: z.array(z.object({ status: z.enum(['pending','prepared','withheld','manual']), reason: text.nullable(), count })).optional(),
  publicationAdmissionDenials: z.array(publicationAdmissionDenialSchema).optional(),
});
