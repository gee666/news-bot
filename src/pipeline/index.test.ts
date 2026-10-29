import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ held: [] as boolean[], query: vi.fn(), publish: vi.fn(), refresh: vi.fn(), release: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query, connect: async () => ({
  query: async (sql: string) => ({ rows: sql.includes('pg_try_advisory_lock') ? [{ held: mocks.held.shift() ?? false }] : [] }),
  release: mocks.release,
}) }, transaction: vi.fn() }));
vi.mock('../settings.js', async original => {
  const actual = await original<typeof import('../settings.js')>();
  return { ...actual, getSettings: async () => actual.defaultSettings };
});
vi.mock('../publishing/index.js', () => ({ publishDigest: mocks.publish }));
vi.mock('./stories.js', () => ({ refreshDigest: mocks.refresh }));
vi.mock('./judgments.js', () => ({ Judgments: class { async close() {} } }));
vi.mock('./batches.js', () => ({ processBatch: vi.fn() }));
vi.mock('./source-links.js', () => ({ associateSourceLinks: vi.fn() }));
vi.mock('./vectors.js', () => ({ reembedPending: vi.fn() }));
import { reembedPending } from './vectors.js';
import { createPipeline } from './index.js';
import { associateSourceLinks } from './source-links.js';
import { ProcessingYield } from './processing-slice.js';

beforeEach(() => {
  mocks.held.length = 0;
  vi.mocked(associateSourceLinks).mockReset().mockResolvedValue(undefined);
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.publish.mockReset().mockResolvedValue(undefined);
  mocks.refresh.mockReset().mockResolvedValue({ completedStories: 1, failedStories: 0, skippedStories: 0 });
  mocks.release.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const states = () => mocks.query.mock.calls.filter(call => String(call[0]).includes('INSERT INTO operational_state'))
  .map(call => JSON.parse(String(call[1]?.[1])) as unknown);
it('defers new selection when an unscheduled sweep finds the processor lease busy', async () => {
  mocks.held.push(true,false);
  await (await createPipeline()).runDigest();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(states().at(-1)).toMatchObject({ phase: 'waiting', attempt: 0 });
});
it('defers new selection after an unscheduled sweep checkpoint', async () => {
  vi.mocked(associateSourceLinks).mockRejectedValueOnce(new ProcessingYield());
  mocks.held.push(true,true);
  await (await createPipeline()).runDigest();
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.publish).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledTimes(2);
  expect(states().at(-1)).toMatchObject({ phase: 'waiting', attempt: 0 });
});
it('publishes healthy siblings despite isolated story failures', async () => {
  mocks.refresh.mockResolvedValueOnce({ completedStories: 1, failedStories: 1, skippedStories: 0 });
  mocks.held.push(true,true);
  await (await createPipeline()).runDigest();
  expect(mocks.publish).toHaveBeenCalledOnce();
  expect(states().at(-1)).toMatchObject({ phase: 'completed', failedStories: 1 });
});
it('records and retries infrastructure failures rather than pretending the sweep succeeded', async () => {
  mocks.refresh.mockRejectedValueOnce(new Error('fixture database outage'));
  mocks.held.push(true,true);
  await expect((await createPipeline()).runDigest()).rejects.toThrow('fixture database outage');
  expect(states().at(-1)).toMatchObject({ phase: 'waiting', attempt: 1 });
});

it('terminal failed batches do not block pending reembedding work',async () => {
  mocks.held.push(true);
  mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes('FROM processing_batches') && sql.includes("'failed'") ? [{id:'terminal'}]
    : sql.includes("embedding_configs WHERE status='pending'") ? [{id:'config'}] : []}));
  await (await createPipeline()).runCollection();
  expect(reembedPending).toHaveBeenCalledOnce();
});
