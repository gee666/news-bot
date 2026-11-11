import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), retained: vi.fn(), generate: vi.fn(), currentInput: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: (run: (client: { query: typeof mocks.query }) => Promise<void>) => run({ query: mocks.query }),
}));
vi.mock('./matching.js', () => ({ retainedStories: mocks.retained }));
vi.mock('../models/index.js', () => ({ generateStructured: mocks.generate }));
vi.mock('./generation-model.js', () => ({ generationClient: vi.fn(), recordGenerationFailure: vi.fn(), requireInferenceApproval: vi.fn() }));
vi.mock('./privacy.js', () => ({ approveRemoteInput: vi.fn() }));
vi.mock('./matching-group-input.js', async original => ({
  ...await original<typeof import('./matching-group-input.js')>(), currentMatchingInput: mocks.currentInput,
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
  mocks.currentInput.mockResolvedValue(story);
  mocks.generate.mockResolvedValue({ value: { associations: next ? [{ linkId, targetId: storyId, classification: next }] : [] } });
  mocks.query
    .mockResolvedValueOnce({ rows: [{ original_text: 'Source-only post', access: 'public' }] })
    .mockResolvedValueOnce({ rows: [{ id: linkId, url: 'https://example.org/source', anchor_text: null }] })
    .mockResolvedValueOnce({ rows: [] })
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

it.each([false, true])('revalidates the complete source-only group before writes, changed: %s', async changed => {
  const revisionId = randomUUID(), linkId = randomUUID(), storyId = randomUUID(), siblingId = randomUUID();
  const story = { id: storyId, storyIds: [siblingId, storyId], retentionDays: 7,
    text: 'Release pricing\n\nRelease benchmarks', fingerprint: 'full-group-fingerprint',
    reports: ['Release pricing', 'Release benchmarks'].map(text => ({ text, sourceUrl: null, links: [] })) };
  mocks.retained.mockResolvedValue([story]);
  mocks.currentInput.mockResolvedValue({ ...story, fingerprint: changed ? 'changed-member' : story.fingerprint });
  mocks.generate.mockResolvedValue({ value: { associations: [{ linkId, targetId: storyId, classification: 'relevant' }] } });
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT r.original_text')) return { rows: [{ original_text: 'Source-only recap', access: 'public' }] };
    if (sql.includes('SELECT id,url,anchor_text')) return { rows: [{ id: linkId, url: 'https://example.org/source', anchor_text: null }] };
    if (sql.includes('SELECT 1 FROM source_items')) return { rows: [{ exists: true }] };
    return { rows: [] };
  });
  const { approveRemoteInput } = await import('./privacy.js');
  const run = classifyItemLinks(revisionId, defaultSettings, {
    id: randomUUID(), attempt: 1, batchId: null, revisionId, storyId: null,
  });
  if (changed) await expect(run).rejects.toThrow('Link target changed');
  else await run;

  expect(mocks.currentInput).toHaveBeenCalledExactlyOnceWith(story, { query: mocks.query });
  for (const id of story.storyIds) expect(approveRemoteInput).toHaveBeenCalledWith(
    'https://api.openai.com', expect.any(String), { storyId: id });
  const prompt = JSON.parse(mocks.generate.mock.calls[0]?.[1].prompt);
  expect(prompt.targets).toEqual([{ id: storyId, reports: story.reports }]);
  const calls = mocks.query.mock.calls;
  const membershipLock = calls.findIndex(([sql]) => sql.includes('pg_advisory_xact_lock'));
  const sourceLock = calls.findIndex(([sql]) => sql.includes('ORDER BY i.id FOR SHARE'));
  expect(membershipLock).toBeGreaterThanOrEqual(0);
  expect(sourceLock).toBeGreaterThan(membershipLock);
  expect(calls[sourceLock]?.[1]).toEqual([revisionId, [siblingId, storyId]]);
  expect(mocks.query.mock.invocationCallOrder[sourceLock]).toBeLessThan(mocks.currentInput.mock.invocationCallOrder[0]!);
  expect(calls.filter(([sql]) => /INSERT INTO (story_link_sources|source_link_processing)/u.test(sql)))
    .toHaveLength(changed ? 0 : 2);
});
