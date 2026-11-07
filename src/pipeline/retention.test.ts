import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), query: vi.fn(), media: vi.fn() }));
vi.mock('../db.js', () => ({ transaction: mocks.transaction }));
vi.mock('../media/story-media.js', () => ({ cleanupMedia: mocks.media }));
import { cleanup } from './retention.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(async run => { await run({ query: mocks.query }); });
});

it('sweeps orphaned media only after history deletion commits', async () => {
  let committed = false;
  mocks.transaction.mockImplementation(async run => {
    await run({ query: mocks.query });
    expect(mocks.media).not.toHaveBeenCalled();
    committed = true;
  });
  mocks.media.mockImplementation(async () => { expect(committed).toBe(true); });
  await cleanup(defaultSettings);
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes('DELETE FROM stories'))).toBe(true);
  expect(mocks.media).toHaveBeenCalledExactlyOnceWith();
});

it('leaves media intact when the history transaction rolls back', async () => {
  mocks.transaction.mockImplementation(async run => {
    await run({ query: mocks.query });
    throw new Error('commit failed');
  });
  await expect(cleanup(defaultSettings)).rejects.toThrow('commit failed');
  expect(mocks.media).not.toHaveBeenCalled();
});

it('reports filesystem cleanup failure so it can be retried', async () => {
  mocks.media.mockRejectedValue(new Error('filesystem unavailable'));
  await expect(cleanup(defaultSettings)).rejects.toThrow('filesystem unavailable');
});
