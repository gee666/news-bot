import { describe, expect, it } from 'vitest';
import { batchItemCountsSchema, publicStatusSchema } from './contracts.js';
import { batchStatusLabel, failedStageContext, partialCompletionLabel } from './status-labels.js';

const id = '946b26ea-14f9-473d-8a1f-6bf47b15b62a';
const date = '2026-01-01T00:00:00.000Z';
const counts = { total: 5, completed: 2, rejected: 1, failed: 2, pending: 0 };

describe('public processing status', () => {
  it('retains validated counts and batch context, but removes private fields', () => {
    const parsed = publicStatusSchema.parse({
      batches: [{ id, status: 'completed', started_at: date, completed_at: date, next_retry_at: null,
        waiting_reason: 'Items withheld.', error_code: 'partial_item_failure', item_counts: { ...counts, raw: 'SECRET' }, settings_snapshot: 'SECRET',
        source_counts: { total: 1, completed: 0, failed: 1, pending: 0 }, source_failures: [{ sourceId: id, code: 'publisher_article_failed', url: 'SECRET' }] }],
      waits: [{ batch_id: id, batch_status: 'completed', batch_completed_at: date, batch_error_code: 'partial_item_failure',
        stage: 'extraction', status: 'failed', next_retry_at: null, waiting_reason: null, error_code: 'invalid_output', count: 2,
        original_text: 'SECRET', response_body: 'SECRET' }],
      embeddings: [], publications: [], token: 'SECRET',
      digestRecovery: { phase: 'failed', failure_phase: 'consolidation', code: 'invalid_output', next_retry_at: null, inputBoundary: 'SECRET' },
      aggregateSelections: [{ key: 'selection',status: 'unresolved',phase: 'confirmation',story_id: id,left_id: null,right_id: null,updated_at: date,body: 'SECRET' }],
      publicationAdmissionDenials: [{ publicationId: id, snapshotId: id, operation: 'edit', reason: 'source_quality_changed',
        lastSeenAt: new Date(date), occurrences: 2, snapshot: 'SECRET', text: 'SECRET', url: 'SECRET', credentials: 'SECRET' }],
    });
    expect(parsed.batches[0]?.item_counts).toEqual(counts);
    expect(parsed.waits[0]?.batch_status).toBe('completed');
    expect(parsed.waits[0]?.status).toBe('failed');
    expect(parsed.batches[0]?.source_counts?.failed).toBe(1);
    expect(parsed.publicationAdmissionDenials).toEqual([{ publicationId: id, snapshotId: id, operation: 'edit',
      reason: 'source_quality_changed', lastSeenAt: date, occurrences: 2 }]);
    expect(JSON.stringify(parsed)).not.toContain('SECRET');
  });
  it('keeps the older status response valid when optional diagnostics are absent', () => {
    expect(publicStatusSchema.parse({ batches: [], waits: [], embeddings: [], publications: [] }))
      .toEqual({ batches: [], waits: [], embeddings: [], publications: [] });
  });
  it.each([{ reason: 'https://private.example/token' }, { operation: 'delete' }, { occurrences: 0 },
    { occurrences: 1.5 }, { occurrences: '2' }, { publicationId: 'private text' }, { lastSeenAt: 'invalid' }])(
    'rejects malformed admission diagnostics %j', patch => {
      expect(publicStatusSchema.safeParse({ batches: [], waits: [], embeddings: [], publications: [],
        publicationAdmissionDenials: [{ publicationId: id, snapshotId: id, operation: null, reason: 'publishing_paused',
          lastSeenAt: date, occurrences: 1, ...patch }] }).success).toBe(false);
    });
  it.each([
    { ...counts, failed: -1 }, { ...counts, completed: 2.5 }, { ...counts, total: '5' },
    { ...counts, total: 6 }, { total: 1 },
  ])('rejects invalid counts %j', value => {
    expect(batchItemCountsSchema.safeParse(value).success).toBe(false);
  });
  it('warns about withheld items rather than labelling a partial batch successful', () => {
    expect(batchStatusLabel('completed', 'partial_item_failure', 2)).toBe('Completed with 2 withheld items');
    expect(partialCompletionLabel(1)).toBe('Completed with 1 withheld item');
    expect(batchStatusLabel('completed', 'partial_story_failure', 0)).toBe('Completed with withheld stories');
    expect(failedStageContext('completed', date, 'partial_story_failure')).toContain('Batch completed with errors');
    expect(batchStatusLabel('completed', null, 0)).toBe('completed');
    expect(batchStatusLabel('completed', 'partial_source_failure', 0)).toContain('incomplete source coverage');
    expect(batchStatusLabel('completed','partial_selection_failure',0)).toContain('held comparisons');
    expect(failedStageContext('completed', date, 'partial_source_failure')).toContain('incomplete coverage');
  });
  it('distinguishes historical failure records from resumed and partial-completed batches', () => {
    expect(failedStageContext('completed', date, null)).toContain('Historical failed stage record');
    expect(failedStageContext('processing', null, null)).toContain('Batch is now processing');
    expect(failedStageContext('completed', date, 'partial_item_failure')).toContain('Batch completed with errors');
    expect(failedStageContext('failed', null, 'invalid_output')).toContain('Batch needs attention');
  });
});
