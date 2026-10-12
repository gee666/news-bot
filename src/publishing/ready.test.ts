import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { prepareReadyStories } from './ready.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), prepare: vi.fn(), updates: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../pipeline/failure-admission.js', () => ({ automaticFailureHeld: async () => false }));
vi.mock('../pipeline/generation-freshness.js', () => ({ generationIsCurrent: async () => true }));
vi.mock('../pipeline/eligibility.js', () => ({ guardDigestEligibility: async () => {} }));
vi.mock('./store.js', () => ({ prepareDigest: mocks.prepare }));
vi.mock('./updates.js', () => ({ prepareUpdates: mocks.updates }));

const settings = { ...defaultSettings, publishingEnabled: true };
function event() {
  return { story_id: randomUUID(), token: randomUUID(), content_version: 1,
    profile_version: settings.profileVersion, model_version: settings.modelVersion, manual_operation_id: null };
}

beforeEach(() => {
  mocks.query.mockReset();
  mocks.prepare.mockReset().mockResolvedValue(undefined);
  mocks.updates.mockReset().mockResolvedValue(undefined);
});

it('processes the entire invocation snapshot without a cap or a continuous drain', async () => {
  const initial = Array.from({ length: 41 }, event);
  const later = event();
  let arrived = false;
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM story_publication_ready q')) return { rows: arrived ? [...initial, later] : initial };
    if (sql.startsWith('SELECT status,content_version')) return { rows: [{ status: 'completed', content_version: 1,
      profile_version: settings.profileVersion, model_version: settings.modelVersion, interest_score: 8, interest_stale: false }] };
    if (sql.startsWith('SELECT interest_stale')) return { rows: [{ interest_stale: false }] };
    return { rows: [] };
  });
  mocks.prepare.mockImplementation(async () => { arrived = true; });
  await prepareReadyStories(settings, '-100123');
  const snapshots = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('FROM story_publication_ready q'));
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.[0]).not.toMatch(/\bLIMIT\b/i);
  expect(mocks.prepare.mock.calls.map(([, , scope]) => scope)).toEqual(initial.map(row => ({ storyIds: [row.story_id] })));
  expect(mocks.updates).toHaveBeenCalledTimes(41);
  const acknowledgments = mocks.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE story_publication_ready'));
  expect(acknowledgments).toHaveLength(41);
  for (const [index, row] of initial.entries()) {
    expect(acknowledgments[index]?.[0]).toContain('token=$2');
    expect(acknowledgments[index]?.[1]).toEqual([row.story_id, row.token, 'prepared', null, null]);
  }
});
