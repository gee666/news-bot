import { expect, it } from 'vitest';
import { publicStatusSchema } from '../src/http/contracts.js';
import { statusSchema } from './api';

const id = '11111111-1111-4111-8111-111111111111';
const date = '2026-10-08T10:00:00.000Z';
it('uses the public status contract without dropping recovery or coverage diagnostics', () => {
  expect(statusSchema).toBe(publicStatusSchema);
  const response = { batches: [{ id, status: 'completed', started_at: date, completed_at: date,
    next_retry_at: null, waiting_reason: null, error_code: 'partial_source_failure',
    item_counts: { total: 1, completed: 1, rejected: 0, failed: 0, pending: 0 },
    source_counts: { total: 2, completed: 1, failed: 1, pending: 0 },
    source_failures: [{ sourceId: id, code: 'publisher_article_failed', url: 'SECRET' }] }],
  waits: [], embeddings: [], publications: [],
  digestRecovery: { phase: 'waiting', failure_phase: 'publication', code: 'telegram_cooldown', next_retry_at: date },
  aggregateSelections: [{ key: 'source_link_deferred:hash', status: 'unresolved', phase: 'confirmation',
    story_id: id, left_id: null, right_id: null, updated_at: date }],
  publicationAdmissionDenials: [{ publicationId: id, snapshotId: id, reason: 'source_quality_changed', operation: 'edit',
    lastSeenAt: date, occurrences: 4, text: 'SECRET', credentials: 'SECRET', snapshot: 'SECRET' }],
  };
  const parsed = statusSchema.parse(response);
  expect(parsed.batches[0]?.source_counts?.failed).toBe(1);
  expect(parsed.batches[0]?.source_failures?.[0]?.code).toBe('publisher_article_failed');
  expect(parsed.publicationAdmissionDenials?.[0]?.occurrences).toBe(4);
  expect(JSON.stringify(parsed)).not.toContain('SECRET');
});
it('accepts backward-compatible status responses and rejects count drift', () => {
  const base = { batches: [], waits: [], embeddings: [], publications: [] };
  expect(statusSchema.parse(base)).toEqual(base);
  expect(statusSchema.safeParse({ ...base, batches: [{ id, status: 'completed', started_at: date, completed_at: date,
    next_retry_at: null, waiting_reason: null, error_code: null,
    item_counts: { total: 2, completed: 1, rejected: 0, failed: 0, pending: 0 } }] }).success).toBe(false);
});
