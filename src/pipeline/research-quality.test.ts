import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PiRequest } from '../models/pi.js';
import { defaultSettings } from '../settings.js';
import { researchDocuments, researchEvidence, assessmentPrompt } from './research.js';
import { loadEvidence, saveEvidence, assessEvidence } from './generation-store.js';
import { fetchPage, searchPages } from './research-page.js';
import { ResearchFetchError } from './research-fetch.js';
import { evidenceDocument, modelResult, storyInput } from './generation.test-helpers.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('./generation-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('./generation-store.js')>(), loadEvidence: vi.fn(), saveEvidence: vi.fn(), assessEvidence: vi.fn(),
}));
vi.mock('./research-page.js', () => ({ fetchPage: vi.fn(), searchPages: vi.fn() }));
const generate = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
  vi.mocked(loadEvidence).mockResolvedValue([]);
  vi.mocked(searchPages).mockResolvedValue([]);
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: 'Read document', content: 'Actual content.', access: 'public', metadata: {} }));
  vi.mocked(saveEvidence).mockImplementation(async (_story, page) => ({ ...evidenceDocument(), url: page.url, canonical_url: page.canonicalUrl, content: page.content, title: page.title, access: page.access, metadata: page.metadata }));
  vi.mocked(assessEvidence).mockImplementation(async (_story, doc, role, assessment, _settings, relevance) => ({ ...doc, role, assessment, relevance }));
  generate.mockImplementation(async (request: PiRequest) => request.responseSchema?.name === 'research_queries'
    ? modelResult({ queries: ['Acme original announcement'] })
    : modelResult({ evidence_id: JSON.parse(request.prompt).document.evidence_id, role: 'primary', relevance: 'relevant', reason: 'Original announcement.' }));
});
afterEach(() => vi.unstubAllEnvs());

it.each([5, 6, 7, 10])('stops discovery at score %s once the primary has been read', async score => {
  await researchEvidence(storyInput(score), defaultSettings, { generate });
  expect(searchPages).not.toHaveBeenCalled();
  expect(loadEvidence).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(':read-source-v5'));
});

it.each(['empty', 'failed'] as const)('releases a one-page reservation to a known feed original after %s discovery', async mode => {
  const input = storyInput(5);
  input.links = [];
  input.mentions[0] = { ...input.mentions[0]!, connector_type: 'feed', original_url: 'https://company.org/announcement' };
  if (mode === 'empty') generate.mockResolvedValue(modelResult({ queries: [] }));
  else vi.mocked(searchPages).mockRejectedValue(new ResearchFetchError('fetch_failed'));
  const result = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 1 }, { generate });
  expect(fetchPage).toHaveBeenCalledExactlyOnceWith('https://company.org/announcement');
  expect(result).toHaveLength(1);
});

it('charges unrelated reads to the page budget while reserving primary discovery', async () => {
  const input = storyInput(5);
  input.links = Array.from({ length: 6 }, (_, index) => ({ url: `https://press.org/${index}`, classification: 'relevant' as const }));
  generate.mockImplementation(async (request: PiRequest) => request.responseSchema?.name === 'research_queries'
    ? modelResult({ queries: ['Acme original announcement'] })
    : modelResult({ evidence_id: JSON.parse(request.prompt).document.evidence_id,
      role: request.prompt.includes('company.org') ? 'primary' : 'candidate',
      relevance: request.prompt.includes('company.org') ? 'relevant' : 'irrelevant', reason: 'Exact event assessment.' }));
  vi.mocked(searchPages).mockResolvedValue(['https://company.org/release']);
  const documents = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 2 }, { generate });
  expect(documents.some(doc => doc.role === 'primary')).toBe(true);
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(assessEvidence).toHaveBeenCalledTimes(2);
  expect(researchDocuments(documents)).toHaveLength(1);
});

it.each([0, 2])('caps fetched and assessed pages at five despite irrelevant search results with %s searches', async researchMaxSearches => {
  const input = storyInput(8);
  input.links = Array.from({ length: 30 }, (_, index) => ({ url: `https://press.org/${index}`, classification: 'relevant' as const }));
  vi.mocked(searchPages).mockResolvedValue(Array.from({ length: 30 }, (_, index) => `https://search-result.org/${index}`));
  generate.mockImplementation(async (request: PiRequest) => request.responseSchema?.name === 'research_queries'
    ? modelResult({ queries: ['Exact original announcement'] })
    : modelResult({ evidence_id: JSON.parse(request.prompt).document.evidence_id, role: 'candidate', relevance: 'irrelevant', reason: 'Other event.' }));
  const documents = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 5, researchMaxSearches }, { generate });
  expect(fetchPage).toHaveBeenCalledTimes(5);
  expect(assessEvidence).toHaveBeenCalledTimes(5);
  expect(generate.mock.calls.filter(call => call[0].responseSchema.name === 'primary_assessment')).toHaveLength(5);
  expect(documents).toHaveLength(5);
  expect(researchDocuments(documents)).toHaveLength(0);
  if (researchMaxSearches) expect(searchPages).toHaveBeenCalledWith('Exact original announcement', 1);
});

it.each(['relevant', 'irrelevant'] as const)('reuses an unchanged story/document/current-policy %s assessment on the next research pass', async relevance => {
  const input = storyInput(8);
  const settings = { ...defaultSettings, researchMaxSearches: 0 };
  generate.mockImplementation(async (request: PiRequest) => modelResult({ evidence_id: JSON.parse(request.prompt).document.evidence_id,
    role: relevance === 'relevant' ? 'primary' : 'candidate', relevance, reason: 'Completed assessment.' }));
  const first = await researchEvidence(input, settings, { generate });
  vi.mocked(loadEvidence).mockResolvedValue(first);
  input.story.headline = 'Generated display';
  input.story.summary = 'Generated details';
  input.story.researched = true;
  expect(await researchEvidence(input, settings, { generate })).toEqual(first);
  expect(vi.mocked(loadEvidence).mock.calls[0]).toEqual(vi.mocked(loadEvidence).mock.calls[1]);
  expect(fetchPage).toHaveBeenCalledOnce();
  expect(saveEvidence).toHaveBeenCalledOnce();
  expect(assessEvidence).toHaveBeenCalledOnce();
  expect(generate).toHaveBeenCalledOnce();
});

it('deduplicates arXiv representations and the actually observed revision without repeated assessment', async () => {
  const input = storyInput(8);
  input.links = ['pdf/2609.38036', 'abs/2609.38036', 'html/2609.38036v2'].map(path => ({ url: `https://arxiv.org/${path}`, classification: 'relevant' as const }));
  vi.mocked(fetchPage).mockResolvedValue({ url: input.links[0]!.url, canonicalUrl: 'https://arxiv.org/abs/2609.38036',
    title: 'Actual paper', content: 'Actual full-paper methods and results.', access: 'public',
    metadata: { paper: { id: '2609.38036', version: 'v2', extent: 'full_text' }, representationReads: 1 } });
  expect(await researchEvidence(input, { ...defaultSettings, researchMaxSearches: 0 }, { generate })).toHaveLength(1);
  expect(fetchPage).toHaveBeenCalledExactlyOnceWith(input.links[0]!.url, 2);
  expect(generate).toHaveBeenCalledOnce();
});

it('does not let a wrong-version diagnostic suppress a later valid revision', async () => {
  const input = storyInput(8);
  input.links = ['v2', 'v3'].map(version => ({ url: `https://arxiv.org/pdf/2609.38036${version}`, classification: 'relevant' as const }));
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url,
    title: 'Paper', content: url.endsWith('v2') ? null : 'Valid current findings.', access: url.endsWith('v2') ? 'unavailable' : 'public',
    metadata: { paper: { id: '2609.38036', version: 'v3', extent: 'full_text' }, representationReads: 1 } }));
  const documents = await researchEvidence(input, { ...defaultSettings, researchMaxSearches: 0 }, { generate });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(documents).toHaveLength(2);
  expect(generate).toHaveBeenCalledOnce();
});

it('charges abstract fallback representations to the same actual page budget', async () => {
  const input = storyInput(8);
  input.links = ['2609.38036', '2609.16247', '2609.12345'].map(id => ({ url: `https://arxiv.org/pdf/${id}`, classification: 'relevant' as const }));
  vi.mocked(fetchPage).mockImplementation(async (url, allowance) => ({ url, canonicalUrl: url,
    title: 'Paper', content: 'Author findings.', access: 'public', metadata: { representationReads: allowance === 2 ? 2 : 1 } }));
  await researchEvidence(input, { ...defaultSettings, researchMaxPages: 3, researchMaxSearches: 0 }, { generate });
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[1])).toEqual([2]);
  expect(fetchPage).toHaveBeenCalledOnce();
  expect(generate).toHaveBeenCalledOnce();
});

it('keeps diagnostic candidates out of writer text and puts read primary text first', () => {
  const base = { ...evidenceDocument(), relevance: 'relevant' as const, role: 'supporting' as const };
  expect(researchDocuments([
    { ...base, access: 'unavailable', content: null },
    { ...base, access: 'restricted', content: 'Username Password' },
    { ...base, role: 'candidate' },
    { ...base, relevance: 'uncertain' },
    { ...base, title: 'Sign in to GitHub', canonical_url: 'https://github.com/login' },
    base,
    { ...base, role: 'primary' },
  ]).map(doc => doc.role)).toEqual(['primary', 'supporting']);
});

it('keeps a paywall diagnostic while reading a lawful author/repository search result', async () => {
  const input = storyInput(5);
  input.links = [{ url: 'https://publisher.org/paper', classification: 'relevant' }];
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: null,
    content: url.includes('publisher.org') ? null : '# Original author findings\n\nThe paper reports actual results.',
    access: url.includes('publisher.org') ? 'restricted' : 'public', metadata: {} }));
  vi.mocked(searchPages).mockResolvedValue(['https://repository.edu/author-manuscript']);
  const documents = await researchEvidence(input, defaultSettings, { generate });
  expect(documents).toHaveLength(2);
  expect(documents[0]).toMatchObject({ access: 'restricted', role: 'candidate', relevance: 'uncertain' });
  expect(researchDocuments(documents).map(doc => doc.url)).toEqual(['https://repository.edu/author-manuscript']);
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual(['https://publisher.org/paper', 'https://repository.edu/author-manuscript']);
  const queryRequest = generate.mock.calls.find(call => call[0].responseSchema?.name === 'research_queries')?.[0];
  expect(queryRequest.systemPrompt).toContain('lawful open-access manuscript');
  expect(queryRequest.systemPrompt).toContain('Never seek leaked copies');
});

it('reads a pricing followup from actual page metadata within the existing budget', async () => {
  const input=storyInput(5);input.links=[{url:'https://company.org/',classification:'relevant'}];
  vi.mocked(fetchPage).mockImplementation(async url => ({url,canonicalUrl:url,title:'Company service',content:'Actual service text.',access:'public',
    metadata:url==='https://company.org/'?{followupLinks:[{url:'https://company.org/pricing',title:'Full pricing'}]}:{}}));
  generate.mockImplementation(async (request:PiRequest)=>request.responseSchema?.name==='research_queries'
    ?modelResult({queries:[]})
    :modelResult({evidence_id:JSON.parse(request.prompt).document.evidence_id,role:request.prompt.includes('/pricing')?'primary':'candidate',
      relevance:request.prompt.includes('/pricing')?'relevant':'uncertain',reason:'Specific event assessment.'}));
  const docs=await researchEvidence(input,{...defaultSettings,researchMaxPages:2},{generate});
  expect(vi.mocked(fetchPage).mock.calls.map(call=>call[0])).toEqual(['https://company.org/','https://company.org/pricing']);
  expect(researchDocuments(docs)).toHaveLength(1);
});

it('does not follow announcement links on documents already assessed unrelated', async () => {
  const input=storyInput(8);
  vi.mocked(fetchPage).mockImplementation(async url=>({url,canonicalUrl:url,title:'Unrelated page',content:'Other event',access:'public',
    metadata:{followupLinks:[{url:'https://company.org/pricing',title:'Full pricing'}]}}));
  generate.mockResolvedValue(modelResult({evidence_id:evidenceDocument().id,role:'candidate',relevance:'irrelevant',reason:'Other event.'}));
  await researchEvidence(input,defaultSettings,{generate});
  expect(fetchPage).toHaveBeenCalledOnce();
});

it('passes read byline to assessment without promoting a social domain automatically', async () => {
  const input = storyInput(8);
  input.links = [{ url: 'https://x.com/reporter/status/101', classification: 'relevant' }];
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: 'A report', content: 'A secondhand report.',
    access: 'public', metadata: { byline: 'Reporter (@reporter)' } }));
  generate.mockImplementation(async (request: PiRequest) => modelResult({ evidence_id: JSON.parse(request.prompt).document.evidence_id,
    role: 'supporting', relevance: 'relevant', reason: 'Secondhand report, not an involved announcer.' }));
  const docs = await researchEvidence(input, { ...defaultSettings,researchMaxSearches:0 }, { generate });
  expect(docs[0]?.role).toBe('supporting');
  expect(JSON.parse(generate.mock.calls[0]![0].prompt).document.byline).toBe('Reporter (@reporter)');
});

it('requires claim-scoped authority for original research and announcements', () => {
  expect(assessmentPrompt).toContain('Do not downgrade the original paper');
  expect(assessmentPrompt).toContain('author-written abstract is primary evidence');
  expect(assessmentPrompt).toContain('which remain unconfirmed');
  expect(assessmentPrompt).toContain('general benchmark rankings or methodology page is supporting background');
  expect(assessmentPrompt).toContain('Platform X/Twitter alone is neither proof');
  expect(assessmentPrompt).toContain('own product documentation directly establishing');
});
