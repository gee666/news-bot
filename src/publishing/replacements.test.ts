import type { PoolClient } from 'pg';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import type { Publication } from './store.js';
import { prepareReplacements, replacementAdmitted, replacementCoversGroup } from './replacements.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), same: vi.fn(), admission: vi.fn(), supersede: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: vi.fn() } }));
vi.mock('./freshness.js', () => ({ publicationAdmission: mocks.admission }));
vi.mock('./navigation.js', () => ({ confirmedDelivery: 'confirmed', delivered: 'delivered', sameStoryIds: mocks.same }));
vi.mock('./store.js', () => ({ publicationEditSelect: 'SELECT p.* FROM publications p', supersedeAttempts: mocks.supersede }));
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const latest = '33333333-3333-4333-8333-333333333333';
const client = { query: mocks.query } as unknown as PoolClient;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.same.mockResolvedValue([first, second, latest]);
  mocks.admission.mockResolvedValue({ allowed: true });
});

it.each([
  { coverage: [first, second], ancestors: [], allowed: true },
  { coverage: [first], ancestors: [first, second], allowed: false },
  { coverage: [], ancestors: [first, second], allowed: false },
  { coverage: ['invalid'], ancestors: [first, second], allowed: false },
  { coverage: 'invalid', ancestors: [first, second], allowed: false },
  { coverage: null, ancestors: [first], allowed: false },
  { coverage: null, ancestors: [first, second], allowed: true },
])('requires exact branch coverage or legacy directed ancestry: %j', async ({ coverage, ancestors, allowed }) => {
  mocks.query.mockResolvedValue({ rows: [{ coverage, required_story_ids: [first, second], ancestor_story_ids: ancestors }] });
  expect(await replacementCoversGroup(client, 'canonical-post', 'pinned-snapshot', [first, second, latest])).toBe(allowed);
  const [sql, args] = mocks.query.mock.calls[0]!;
  expect(args).toEqual(['canonical-post', 'pinned-snapshot', [first, second, latest]]);
  expect(sql).toContain('j.id=snap.generation_id');
  expect(sql).toContain('p.snapshot_id=$2');
  expect(sql).toContain("j.result->>'headline'=snap.content->>'headline'");
  expect(sql).toContain("j.result->>'summary'=snap.content->>'details'");
  expect(sql).toContain('p.destination_id=c.destination_id AND p.bot_id=c.bot_id');
  expect(sql).not.toContain('expires_at');
});

it('does not treat a missing pinned receipt as deletion coverage', async () => {
  mocks.query.mockResolvedValue({ rows: [] });
  expect(await replacementCoversGroup(client, 'canonical-post', 'snapshot', [first, latest])).toBe(false);
});

it('does not stage an identity-only replacement before a combined successor is published', async () => {
  mocks.query.mockResolvedValueOnce({ rows: [{ id: 'old-post', story_id: first }] })
    .mockResolvedValueOnce({ rows: [{ id: 'existing-branch', snapshot_id: 'branch-snapshot' }] })
    .mockResolvedValueOnce({ rows: [{ coverage: null, required_story_ids: [first], ancestor_story_ids: [second] }] });
  await prepareReplacements(client, '-100123');
  expect(mocks.supersede).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO publication_replacements'))).toBe(false);
});

it.each([false, true])('rechecks coverage at deletion even for an already staged proof, covered: %s', async covered => {
  const old = { id: 'old-post', status: 'published', story_id: first, message_id: '100', snapshot_id: 'old-snapshot',
    pending_snapshot_id: null, destination_id: '-100123', bot_id: '123' } as Publication;
  const canonical = { ...old, id: 'canonical-post', story_id: latest, message_id: '101', snapshot_id: 'canonical-snapshot' };
  mocks.query.mockResolvedValueOnce({ rows: [canonical] })
    .mockResolvedValueOnce({ rows: [{ exists: true }] })
    .mockResolvedValueOnce({ rows: [{ ...old, canonical_story_id: latest, duplicate_story_id: first }] })
    .mockResolvedValueOnce({ rows: [{ coverage: covered ? [first, second] : [first],
      required_story_ids: [first, second], ancestor_story_ids: [] }] });
  expect(await replacementAdmitted(client, old, defaultSettings, {
    canonicalPublicationId: canonical.id, canonicalSnapshotId: canonical.snapshot_id,
  })).toBe(covered);
  expect(mocks.query).toHaveBeenCalledTimes(4);
});
