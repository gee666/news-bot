import { resolve } from 'node:path';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createServices, type RuntimePipeline } from './services.js';
import { publicStatusSchema } from './contracts.js';

const query = vi.hoisted(() => vi.fn());
vi.mock('../db.js', () => ({ db: { query } }));
const id = '946b26ea-14f9-473d-8a1f-6bf47b15b62a';
const date = '2026-10-08T10:00:00.000Z';
let runtime: ModelRuntime;
beforeAll(async () => {
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
});
beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [] }); });
function heldServices() {
  const pipeline: RuntimePipeline = {
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), runCollection: vi.fn(async () => {}),
    runDigest: vi.fn(async () => {}), runCleanup: vi.fn(async () => {}),
    runNow: vi.fn(async () => ({ status: 'succeeded' as const, message: 'Finished.' })), status: vi.fn(async () => ({})),
  };
  return { pipeline, ...createServices(pipeline, { modelRuntime: runtime,
    agentDir: resolve('tmp/status-test-auth'), authPath: resolve('tmp/status-test-auth/auth.json') }) };
}
it('projects bounded historical admission denials and tolerates legacy or corrupt records without dispatch', async () => {
  const valid = { publicationId: id, snapshotId: id, operation: 'send', reason: 'consolidation_unresolved', lastSeenAt: date, occurrences: 3 };
  query.mockImplementation(async (sql: string) => ({ rows: sql.includes("key LIKE 'publication_admission:%'") ? [
    { ...valid, content: 'SECRET', url: 'https://private.example/SECRET', credentials: 'SECRET' },
    { ...valid, operation: null, reason: 'publishing_paused', occurrences: 1 },
    { ...valid, reason: 'https://private.example/SECRET' },
    { ...valid, occurrences: 'bad' }, { ...valid, publicationId: 'SECRET' },
  ] : [] }));
  const held = heldServices();
  const status = publicStatusSchema.parse(await held.services.status());
  expect(status.publicationAdmissionDenials).toEqual([valid, { ...valid, operation: null, reason: 'publishing_paused', occurrences: 1 }]);
  expect(JSON.stringify(status)).not.toContain('SECRET');
  const sql = String(query.mock.calls.find(([value]) => String(value).includes("key LIKE 'publication_admission:%'"))?.[0]);
  expect(sql).toContain('LIMIT 100'); expect(sql).toContain("value->>'lastSeenAt'"); expect(sql).toContain("value->>'at'");
  expect(sql).toContain("coalesce(value->'occurrences','1'::jsonb)");
  expect(sql).not.toMatch(/SELECT\s+(?:\*|value\s|value,)/iu);
  expect(query.mock.calls.every(([value]) => String(value).trimStart().startsWith('SELECT'))).toBe(true);
  expect(held.pipeline.runDigest).not.toHaveBeenCalled(); expect(held.pipeline.runCollection).not.toHaveBeenCalled();
  expect(held.pipeline.runNow).not.toHaveBeenCalled();
  await held.operations.stop();
});
it('retains source coverage, digest holds and scoped recovery fields through the public status boundary', async () => {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM processing_batches b ORDER BY')) return { rows: [{ id, status: 'completed', started_at: date,
      completed_at: date, next_retry_at: null, waiting_reason: null, error_code: 'partial_source_failure',
      item_counts: { total: 1, completed: 1, rejected: 0, failed: 0, pending: 0 },
      source_counts: { total: 2, completed: 1, failed: 1, pending: 0 },
      source_failures: [{ sourceId: id, code: 'publisher_article_failed', url: 'SECRET' }] }] };
    if (sql.includes("key='pipeline_digest'")) return { rows: [{ phase: 'failed', failure_phase: 'source_links', code: 'invalid_output', next_retry_at: null }] };

    if (sql.includes("key LIKE 'consolidation_deferred:%'")) return { rows: [{ key: 'consolidation_deferred:hash', status: 'unresolved', phase: null,
      story_id: null, left_id: id, right_id: id, updated_at: date, body: 'SECRET' }] };

    return { rows: [] };
  });
  const held = heldServices();
  const status = publicStatusSchema.parse(await held.services.status());
  expect(status.batches[0]?.source_counts?.failed).toBe(1);
  expect(status.batches[0]?.source_failures).toEqual([{ sourceId: id, code: 'publisher_article_failed' }]);
  expect(JSON.stringify(status)).not.toContain('SECRET');
  expect(query.mock.calls.every(([value]) => String(value).trimStart().startsWith('SELECT'))).toBe(true);
  await held.operations.stop();
});
