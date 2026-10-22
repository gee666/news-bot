import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), retained: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: vi.fn() }));
vi.mock('./matching.js', () => ({ retainedStories: mocks.retained }));
import { associateSourceLinks } from './source-links.js';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.retained.mockResolvedValue([]);
});
it('defers catalogue-wide enrichment while current intake awaits extraction', async () => {
  mocks.query.mockResolvedValue({ rows: [{ pending: true }] });
  await associateSourceLinks(defaultSettings);
  expect(mocks.query).toHaveBeenCalledOnce();
  expect(mocks.retained).not.toHaveBeenCalled();
});
it('resumes catalogue enrichment once extraction catches up', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ pending: false }] }).mockResolvedValue({ rows: [] });
  await associateSourceLinks(defaultSettings);
  expect(mocks.retained).toHaveBeenCalledOnce();
  expect(mocks.query).toHaveBeenCalledTimes(2);
});
