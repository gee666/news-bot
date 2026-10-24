import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { jevTemplates } from '../models/templates.js';
import { alreadyGenerated, evidenceSnapshotHash, generationHash } from './generation-store.js';
import { evidenceId, storyId, storyInput } from './generation.test-helpers.js';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [] });
});

const legacyRow = (role: 'primary' | 'supporting' | 'candidate') => ({
  id: evidenceId, url: 'https://example.org/release', canonical_url: null, title: 'Release',
  content: 'Original evidence', access: 'public', metadata: { status: 200 },
  role, assessment: 'Original assessment', unexpired: true,
});
const oldHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('pins the research hash for the cumulative generation policy', () => {
  expect(generationHash(storyInput(), defaultSettings)).toBe('eb3a9cc0ea8e251be8fe25b2781f9b382d513580b11c339d2e4a8d5147a7dd37');
});

it.each([
  ['primary', 'relevant'], ['supporting', 'relevant'], ['candidate', 'uncertain'],
] as const)('preserves the pre-090 bytes for legacy %s and its default %s relevance', async (role, relevance) => {
  const row = legacyRow(role);
  const expected = oldHash([row]);
  mocks.query.mockResolvedValueOnce({ rows: [row] });
  expect(await evidenceSnapshotHash(storyId)).toBe(expected);
  // Match SQL property order, with relevance appended after the legacy fields.
  mocks.query.mockResolvedValueOnce({ rows: [{ ...row, relevance }] });
  expect(await evidenceSnapshotHash(storyId)).toBe(expected);
  expect(mocks.query.mock.calls[1]?.[0]).not.toContain('se.assessed_at');
});

it.each(['primary', 'supporting', 'candidate'] as const)('invalidates %s evidence when relevance becomes irrelevant', async role => {
  const row = legacyRow(role);
  mocks.query.mockResolvedValueOnce({ rows: [{ ...row, relevance: 'irrelevant' }] });
  expect(await evidenceSnapshotHash(storyId)).not.toBe(oldHash([row]));
});

it.each(['primary', 'supporting'] as const)('invalidates %s evidence when relevance becomes uncertain', async role => {
  const row = legacyRow(role);
  mocks.query.mockResolvedValueOnce({ rows: [{ ...row, relevance: 'uncertain' }] });
  expect(await evidenceSnapshotHash(storyId)).not.toBe(oldHash([row]));
});

it('distinguishes explicit candidate-relevant from legacy candidate-uncertain', async () => {
  const row = legacyRow('candidate');
  mocks.query.mockResolvedValueOnce({ rows: [{ ...row, relevance: 'relevant' }] });
  expect(await evidenceSnapshotHash(storyId)).not.toBe(oldHash([row]));
});

it('does not invalidate usable evidence when empty failed-read retry TTLs expire', async () => {
  const primary = legacyRow('primary');
  const failed = { ...legacyRow('candidate'), id: '22222222-2222-4222-8222-222222222222',
    content: null, access: 'restricted', assessment: null };
  mocks.query.mockResolvedValueOnce({ rows: [primary, { ...failed, unexpired: true }] })
    .mockResolvedValueOnce({ rows: [primary, { ...failed, unexpired: false }] });
  expect(await evidenceSnapshotHash(storyId)).toBe(oldHash([primary]));
  expect(await evidenceSnapshotHash(storyId)).toBe(oldHash([primary]));
});
it('still invalidates expiration of a usable primary source and excludes corrupt metadata locally', async () => {
  const primary = legacyRow('primary');
  mocks.query.mockResolvedValueOnce({ rows: [{ ...primary, unexpired: false }] })
    .mockResolvedValueOnce({ rows: [primary, { ...primary, metadata: { status: 'wrong' } }] });
  expect(await evidenceSnapshotHash(storyId)).not.toBe(oldHash([primary]));
  expect(await evidenceSnapshotHash(storyId)).toBe(oldHash([primary]));
});

it('reuses a current-policy receipt with an unchanged pre-090 evidence signature', async () => {
  const input = storyInput();
  input.story.headline = 'News'; input.story.summary = 'Details'; input.story.researched = true;
  const row = legacyRow('primary');
  mocks.query.mockResolvedValueOnce({ rows: [{ result: { evidenceSignature: oldHash([row]) } }] })
    .mockResolvedValueOnce({ rows: [{ ...row, relevance: 'relevant' }] });
  expect(await alreadyGenerated(input, defaultSettings)).toBe(true);
});

it('invalidates legacy generation receipts for the calibrated policy without changing model or profile settings', async () => {
  const input = storyInput();
  const mention = input.mentions[0];
  if (!mention) throw new Error('Missing fixture mention');
  const expected = oldHash({
    stage: 'research', promptVersion: 'generation-v8', researchPolicy: 'supplied-links-budget-v2',
    representativeVersion: jevTemplates.representative.version,
    model: [defaultSettings.piProvider, defaultSettings.piModel, defaultSettings.modelVersion],
    contentVersion: input.story.content_version, content: { mentions: [mention.text] },
    links: [[input.links[0]?.url, 'relevant', undefined, undefined, undefined]], supplementaryReports: [],
    excerpt: input.story.chosen_excerpt,
    headlineContext: [JSON.stringify({ id: mention.id, text: mention.text, access: mention.access,
      url: mention.original_url, referents: [], framing: [] })],
    depth: { threshold: defaultSettings.researchThreshold,
      deep: (input.story.interest_score ?? 0) >= defaultSettings.researchThreshold,
      pages: defaultSettings.researchMaxPages, searches: defaultSettings.researchMaxSearches },
  });
  const settingsBefore = JSON.stringify(defaultSettings);
  input.story.headline = 'Acme выпустила обновление'; input.story.summary = 'Исправлена ошибка безопасности.';
  input.story.researched = true;
  const current = generationHash(input, defaultSettings);
  expect(current).not.toBe(expected);
  const receipt = { result: { evidenceSignature: oldHash([]) } };
  // Simulate a persisted v8 receipt with otherwise identical inputs, model, output and evidence.
  mocks.query.mockImplementation(async (sql: string, args: unknown[] = []) => ({ rows:
    sql.includes('SELECT result FROM judgments') && sql.includes("prompt_version = 'generation-v8'") && args[2] === expected
      ? [receipt] : [],
  }));
  expect(await alreadyGenerated(input, defaultSettings)).toBe(false);
  expect(mocks.query).toHaveBeenCalledOnce();
  expect(mocks.query.mock.calls[0]?.[0]).toContain("prompt_version = 'generation-v14-retained-editions'");
  expect(mocks.query.mock.calls[0]?.[1]?.[2]).toBe(current);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT result FROM judgments') ? [receipt] : [] }));
  expect(await alreadyGenerated(input, defaultSettings)).toBe(true);
  expect(JSON.stringify(defaultSettings)).toBe(settingsBefore);
  expect(mocks.query.mock.calls.every(([sql]) => (/^(SELECT|WITH RECURSIVE) /u).test(String(sql)))).toBe(true);
});



it('invalidates cached summaries when media locations or the image cap change', () => {
  const input = storyInput();
  const baseline = generationHash(input, defaultSettings);
  input.mentions[0]!.media = [{ type: 'image', url: 'https://example.org/new.png' }];
  expect(generationHash(input, defaultSettings)).not.toBe(baseline);
  const withImage = generationHash(input, defaultSettings);
  vi.stubEnv('MEDIA_SUMMARY_MAX_IMAGES', '2');
  try { expect(generationHash(input, defaultSettings)).not.toBe(withImage); }
  finally { vi.unstubAllEnvs(); }
});
