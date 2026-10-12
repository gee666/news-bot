import { afterEach, expect, it, vi } from 'vitest';
import { researchEvidence, researchReports } from './research.js';
import { loadEvidence } from './generation-store.js';
import { defaultSettings } from '../settings.js';
import { evidenceId, secondId, storyInput } from './generation.test-helpers.js';
import type { SupplementaryReport } from './generation-store.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('./generation-store.js', async original => ({
  ...await original<typeof import('./generation-store.js')>(), loadEvidence: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());

function report(text: string, published_at = '2026-09-29T21:58:00Z'): SupplementaryReport {
  return { source_id: secondId, revision_id: evidenceId, text, source_name: 'ForgetMe',
    original_url: 'https://t.me/forgetmeai/6403', access: 'public', published_at,
    collected_at: '2026-09-30T08:00:00Z' };
}

it('keeps full reports in newest-first order and preserves publication chronology', () => {
  const input = storyInput();
  const text = 'Новый тариф 10x 😀 '.repeat(2000);
  input.supplementary_reports = [
    { ...report('Old terms', '2026-09-29T11:00:00Z'), revision_id: secondId },
    report(text),
  ];
  const excerpts = researchReports(input);
  expect(excerpts[0]?.revision_id).toBe(evidenceId);
  expect(excerpts).toHaveLength(2);
  expect(excerpts[0]).toMatchObject({ published_at: '2026-09-29T21:58:00Z',
    time_basis: 'published', reported_at: '2026-09-29T21:58:00Z' });
  expect(excerpts[0]?.text).toBe(text);
  expect(input.supplementary_reports[1]?.text).toBe(text);
});

it.each(['restricted', 'unknown'] as const)('blocks %s supplementary text before research fetching or inference', async access => {
  vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
  const input = storyInput();
  input.supplementary_reports = [{ ...report('Private terms'), access }];
  const generate = vi.fn();
  await expect(researchEvidence(input, defaultSettings, { generate })).rejects.toMatchObject({
    metadata: { kind: 'invalid_request' },
  });
  expect(loadEvidence).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});
