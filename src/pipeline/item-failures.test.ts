import { beforeEach, expect, it, vi } from 'vitest';
import { itemWork } from './item-failures.js';
import { ProcessingYield } from './processing-slice.js';
const query = vi.hoisted(() => vi.fn());
vi.mock('../db.js', () => ({ db: { query }, transaction: vi.fn() }));
beforeEach(() => query.mockReset().mockResolvedValue({ rows: [{ status: 'waiting' }] }));
it('a waiting failed item does not prevent its sibling from progressing', async () => {
  const failed = new Set<string>();
  const matching = vi.fn(async () => {});
  await itemWork('batch', 'bad', failed, async () => { throw new Error('provider failure'); });
  await itemWork('batch', 'good', failed, matching);
  expect(matching).toHaveBeenCalledOnce();
  expect(failed).toEqual(new Set(['bad']));
  expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE processing_batches'))).toBe(false);
});
it('exhausted failures mark only the failed revision', async () => {
  query.mockResolvedValueOnce({ rows: [{ status: 'failed' }] });
  await itemWork('batch', 'bad', new Set(), async () => { throw new Error('bad'); });
  expect(query.mock.calls.at(-1)?.[1]).toEqual(['batch', 'bad']);
});
it('does not swallow checkpoints or errors without a persisted unit failure', async () => {
  await expect(itemWork('batch', 'item', new Set(), async () => { throw new ProcessingYield(); })).rejects.toBeInstanceOf(ProcessingYield);
  query.mockResolvedValueOnce({ rows: [] });
  await expect(itemWork('batch', 'item', new Set(), async () => { throw new Error('database unavailable'); })).rejects.toThrow('database unavailable');
});
