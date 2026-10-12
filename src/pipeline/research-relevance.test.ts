import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { assessEvidence, loadEvidence, saveEvidence } from './generation-store.js';
import { fetchPage, searchPages } from './research-page.js';
import { assessmentSchema, researchDocuments, researchEvidence } from './research.js';
import { evidenceDocument, evidenceId, modelResult, storyInput } from './generation.test-helpers.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('./generation-store.js', async original => ({
  ...await original<typeof import('./generation-store.js')>(), loadEvidence: vi.fn(), saveEvidence: vi.fn(), assessEvidence: vi.fn(),
}));
vi.mock('./research-page.js', () => ({ fetchPage: vi.fn(), searchPages: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
  vi.mocked(loadEvidence).mockResolvedValue([]);
  vi.mocked(searchPages).mockResolvedValue([]);
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: 'Another product',
    content: 'A different company released an unrelated product.', access: 'public', metadata: { status: 200 } }));
  vi.mocked(saveEvidence).mockImplementation(async (_id, page) => ({ ...evidenceDocument(), url: page.url,
    content: page.content, access: page.access }));
  vi.mocked(assessEvidence).mockImplementation(async (_id, document, role, assessment, _settings, relevance) => ({
    ...document, role, relevance, assessment,
  }));
});
afterEach(() => vi.unstubAllEnvs());

it('requires typed relevance independently of evidence authority', () => {
  expect(assessmentSchema.safeParse({ evidence_id: evidenceId, role: 'candidate', reason: 'Unrelated.' }).success).toBe(false);
  expect(assessmentSchema.parse({ evidence_id: evidenceId, role: 'candidate', relevance: 'irrelevant', reason: 'Other event.' }))
    .toMatchObject({ relevance: 'irrelevant' });
});

it('records unrelated successfully read content without changing collected link decisions', async () => {
  const input = storyInput();
  const links = structuredClone(input.links);
  const generate = vi.fn().mockResolvedValue(modelResult({ evidence_id: evidenceId, role: 'candidate',
    relevance: 'irrelevant', reason: 'Документ о другом продукте.' }));
  const documents = await researchEvidence(input, defaultSettings, { generate });
  expect(documents[0]).toMatchObject({ relevance: 'irrelevant', role: 'candidate' });
  expect(input.links).toEqual(links);
  expect(researchDocuments(documents)).toEqual([]);
});

it('keeps HTTP 403 and empty pages uncertain without asking the model to infer irrelevance', async () => {
  vi.mocked(fetchPage).mockResolvedValue({ url: 'https://example.org/release', canonicalUrl: null, title: null,
    content: null, access: 'restricted', metadata: { status: 403 } });
  const generate = vi.fn();
  const documents = await researchEvidence(storyInput(), defaultSettings, { generate });
  expect(documents[0]).toMatchObject({ role: 'candidate', relevance: 'uncertain' });
  expect(assessEvidence).not.toHaveBeenCalled();
  expect(generate).not.toHaveBeenCalled();
});

it('rejects unrelated primary output instead of granting authority', async () => {
  const generate = vi.fn().mockResolvedValue(modelResult({ evidence_id: evidenceId, role: 'primary',
    relevance: 'irrelevant', reason: 'Other event.' }));
  const documents = await researchEvidence(storyInput(), defaultSettings, { generate });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(documents[0]).toMatchObject({ role: 'candidate', relevance: 'uncertain' });
  expect(assessEvidence).not.toHaveBeenCalled();
});

it('a relevant reassessment admits that document without a permanent URL blacklist', () => {
  const document = { ...evidenceDocument(), relevance: 'irrelevant' as const };
  expect(researchDocuments([document])).toEqual([]);
  expect(researchDocuments([{ ...document, relevance: 'relevant', role: 'supporting' }])).toHaveLength(1);
});
