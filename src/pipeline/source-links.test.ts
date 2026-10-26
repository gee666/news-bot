import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), retained: vi.fn(), generate: vi.fn(), eventInput: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: (run: (client: { query: typeof mocks.query }) => Promise<void>) => run({ query: mocks.query }),
}));
vi.mock('./matching.js', () => ({ retainedStories: mocks.retained }));
vi.mock('../models/index.js', () => ({ generateStructured: mocks.generate }));
vi.mock('./generation-model.js', () => ({ generationClient: vi.fn(), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: vi.fn() }));
vi.mock('./consolidation-input.js', async original => ({
  ...await original<typeof import('./consolidation-input.js')>(), eventInput: mocks.eventInput,
}));
import { associateSourceLinks, classifyItemLinks } from './source-links.js';
beforeEach(() => {
  vi.resetAllMocks();
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

it.each([
  [null, 'irrelevant', false],
  ['irrelevant', null, false],
  ['irrelevant', 'irrelevant', false],
  [null, 'uncertain', false],
  ['uncertain', null, false],
  ['irrelevant', 'uncertain', false],
  ['uncertain', 'irrelevant', false],
  ['uncertain', 'uncertain', false],
  [null, null, false],
  [null, 'relevant', true],
  ['irrelevant', 'relevant', true],
  ['uncertain', 'relevant', true],
  ['relevant', null, true],
  ['relevant', 'irrelevant', true],
  ['relevant', 'uncertain', true],
  ['relevant', 'relevant', false],
] as const)('queues refresh for source-link %s -> %s only when relevance changes: %s', async (previous, next, refresh) => {
  const revisionId = randomUUID();
  const linkId = randomUUID();
  const storyId = randomUUID();
  const story = { id: storyId, text: 'Existing story', fingerprint: 'unchanged', reports: [] };
  mocks.retained.mockResolvedValue([story]);
  mocks.eventInput.mockResolvedValue(story);
  mocks.generate.mockResolvedValue({ value: { associations: next ? [{ linkId, targetId: storyId, classification: next }] : [] } });
  mocks.query
    .mockResolvedValueOnce({ rows: [{ original_text: 'Source-only post', access: 'public' }] })
    .mockResolvedValueOnce({ rows: [{ id: linkId, url: 'https://example.org/source', anchor_text: null }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ id: randomUUID() }] })
    .mockResolvedValueOnce({ rows: [{ exists: true }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: previous ? [{ link_id: linkId, story_id: storyId, classification: previous }] : [] })
    .mockResolvedValue({ rows: [] });

  await classifyItemLinks(revisionId, defaultSettings, {
    id: randomUUID(), attempt: 1, batchId: null, revisionId, storyId: null,
  });

  const refreshQueries = mocks.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO operational_state'));
  expect(refreshQueries).toHaveLength(refresh ? 1 : 0);
  if (refresh) expect(refreshQueries[0]?.[1]).toEqual([[storyId]]);
  const inserts = mocks.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO story_link_sources'));
  expect(inserts).toHaveLength(next ? 1 : 0);
  if (next) expect(inserts[0]?.[1]).toEqual(expect.arrayContaining([linkId, storyId, next]));
});
