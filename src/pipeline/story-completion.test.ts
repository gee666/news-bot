import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { Judgments } from './judgments.js';
import { refreshDigest } from './stories.js';
import { generationIsCurrent } from './generation-freshness.js';
import { enqueueReadyStory } from '../publishing/ready.js';
const id = '00000000-0000-4000-8000-000000000001';
const mocks = vi.hoisted(() => ({ query: vi.fn(), completed: true }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
vi.mock('../publishing/ready.js', () => ({ enqueueReadyStory: vi.fn() }));
vi.mock('./generation.js', () => ({ researchStory: vi.fn() }));
vi.mock('./generation-freshness.js', () => ({ generationIsCurrent: vi.fn(async () => true) }));
vi.mock('./eligibility.js', () => ({ assessEligibility: async () => true, currentDecision: 'SELECT 1' }));
vi.mock('./consolidation-input.js', () => ({ eventInput: async () => ({ fingerprint: 'fixed', reports: [{ text: 'Release.' }] }) }));
vi.mock('./story-failures.js', () => ({
  storyWork: async (_id: string, _settings: unknown, _batch: unknown, run: () => Promise<boolean>) => { await run(); return 'completed'; },
  countStoryOutcome: vi.fn(), prepareStoryFailureUpdates: vi.fn(),
}));
vi.mock('./vectors.js', () => ({ Vectors: class { async save() {} async close() {} } }));
vi.mock('../settings.js', async original => ({ ...await original<typeof import('../settings.js')>(), getActiveEmbeddingConfig: async () => ({}) }));
beforeEach(() => {
  vi.clearAllMocks(); mocks.completed = true;
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT s.id,s.content_version')) return { rows: [{ id, status: 'processing' }] };
    if (sql.startsWith('SELECT chosen_excerpt')) return { rows: [{ chosen_excerpt: 'Release.', content_version: 1 }] };
    if (sql.includes('AS "representativePresent"')) return { rows: [{ representativePresent: true, headlinePresent: true,
      unblocked: true, eligibilityCurrent: true, rankingCurrent: true }] };
    if (sql.includes("UPDATE stories SET status='completed'")) return { rows: mocks.completed ? [{ id }] : [] };
    return { rows: [] };
  });
});
it.each([true, false])('checks once before the guarded completion update, row returned: %s', async completed => {
  mocks.completed = completed;
  const judgments = new Judgments(defaultSettings);
  vi.spyOn(judgments, 'judge').mockResolvedValue({ type: 'score', score: 6, probabilities: {}, confidence: 1, legend: {} });
  try {
    const result = refreshDigest(defaultSettings, judgments, [id]);
    if (completed) await result;
    else await expect(result).rejects.toThrow('story changed during refresh');
    expect(generationIsCurrent).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('AS "representativePresent"'))).toHaveLength(1);
    expect(enqueueReadyStory).toHaveBeenCalledTimes(completed ? 1 : 0);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('SELECT 1 FROM stories'))).toBe(false);
  } finally { await judgments.close(); }
});
