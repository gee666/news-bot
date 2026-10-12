import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PiRequest } from '../models/pi.js';
import { cleanArticle } from '../sources/article.js';
import { defaultSettings } from '../settings.js';
import { assessEvidence, loadEvidence, saveEvidence } from './generation-store.js';
import { evidenceDocument, evidenceId, modelResult, storyInput } from './generation.test-helpers.js';
import { fetchPage, searchPages } from './research-page.js';
import { assessmentPrompt, researchDocuments, researchEvidence } from './research.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('./generation-store.js', async original => ({
  ...await original<typeof import('./generation-store.js')>(), loadEvidence: vi.fn(), saveEvidence: vi.fn(), assessEvidence: vi.fn(),
}));
vi.mock('./research-page.js', () => ({ fetchPage: vi.fn(), searchPages: vi.fn() }));
const generate = vi.fn();
const settings = { ...defaultSettings, researchMaxPages: 2, researchMaxSearches: 0 };
const root = 'https://discovery.org/repost';
const original = 'https://author.org/article';
const followupLinks = [{ url: original, title: 'Original article' }];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
  vi.stubEnv('RESEARCH_PREFERRED_DOMAINS', '');
  vi.mocked(loadEvidence).mockResolvedValue([]);
  vi.mocked(searchPages).mockResolvedValue([]);
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url,
    title: 'Read report', content: url === original ? 'We measured version 2.0 ourselves.' : 'A repost links to an article.',
    access: 'public', metadata: url === root ? { followupLinks } : {} }));
  vi.mocked(saveEvidence).mockImplementation(async (_id, page, _settings, researchInputHash) => ({ ...evidenceDocument(), url: page.url,
    canonical_url: page.canonicalUrl, title: page.title, content: page.content, access: page.access,
    metadata: { ...page.metadata, researchInputHash } }));
  vi.mocked(assessEvidence).mockImplementation(async (_id, document, role, assessment, _settings, relevance) => ({
    ...document, role, assessment, relevance,
  }));
  generate.mockImplementation(async (request: PiRequest) => {
    if (request.responseSchema?.name === 'research_queries') return modelResult({ queries: ['Original version 2.0 report'] });
    const document = JSON.parse(request.prompt).document;
    return modelResult({ evidence_id: document.evidence_id, role: document.content.includes('ourselves') ? 'primary' : 'supporting',
      relevance: 'relevant', reason: 'Read text and firsthand involvement assessed for this claim.' });
  });
});
afterEach(() => vi.unstubAllEnvs());

it('reads a root followup before another root or unrelated supplied links within the same budget', async () => {
  const input = storyInput(3);
  input.links = [
    { url: 'https://secondary.org/recap', classification: 'relevant' },
    { url: 'https://t.me/invite', classification: 'uncertain' },
  ];
  input.mentions = [
    { ...input.mentions[0]!, connector_type: 'web', original_url: root },
    { ...input.mentions[0]!, connector_type: 'rss', original_url: 'https://discovery.org/another-repost' },
  ];
  const docs = await researchEvidence(input, settings, { generate });
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual([root, original]);
  expect(docs).toHaveLength(2);
  expect(researchDocuments(docs)[0]).toMatchObject({ url: original, content: 'We measured version 2.0 ourselves.', role: 'primary' });
  expect(JSON.parse(generate.mock.calls[1]![0].prompt).document.content).toBe('We measured version 2.0 ourselves.');
});

it('attempts linked originals before web/feed intake without treating either URL as authority', async () => {
  const input = storyInput(3);
  input.mentions[0] = { ...input.mentions[0]!, connector_type: 'rss', original_url: root };
  input.links = [{ url: original, classification: 'relevant', original_url: root }];
  generate.mockResolvedValue(modelResult({ evidence_id: evidenceId, role: 'supporting', relevance: 'relevant', reason: 'Secondhand reporting.' }));
  const docs = await researchEvidence(input, { ...settings, researchMaxPages: 1 }, { generate });
  expect(fetchPage).toHaveBeenCalledExactlyOnceWith(original);
  expect(docs[0]?.role).toBe('supporting');
});

it('keeps a root followup ahead of unrelated links and search', async () => {
  const input = storyInput(8);
  input.mentions[0] = { ...input.mentions[0]!, connector_type: 'web', original_url: root };
  input.links = [{ url: 'https://secondary.org/recap', classification: 'relevant' }];
  const docs = await researchEvidence(input, { ...settings, researchMaxSearches: 2 }, { generate });
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual([root, original]);
  expect(researchDocuments(docs)[0]?.url).toBe(original);
  expect(searchPages).not.toHaveBeenCalled();
});

it.each([0, 2])('prioritizes followups over later supplied links with %s allowed searches', async researchMaxSearches => {
  const input = storyInput(8);
  input.links = [
    { url: root, classification: 'relevant' },
    { url: 'https://secondary.org/recap', classification: 'relevant' },
    { url: 'https://t.me/invite', classification: 'uncertain' },
  ];
  const links = structuredClone(input.links);
  vi.mocked(searchPages).mockResolvedValue(['https://search.org/recap']);
  const docs = await researchEvidence(input, { ...settings, researchMaxSearches }, { generate });
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual([root, original]);
  expect(docs).toHaveLength(2);
  expect(searchPages).not.toHaveBeenCalled();
  expect(input.links).toEqual(links);
});

it('extracts and actually reads only the requested social post article card', async () => {
  const social = 'https://x.com/reporter/status/101';
  const html = '<nav><a href="https://nav.org/">Read more</a></nav><article>'
    + '<a href="/reporter/status/101">Permalink</a><div data-testid="tweetText">Our report.</div>'
    + `<div data-testid="card.wrapper"><a href="${original}">Article preview, not evidence</a></div>`
    + '<article><a href="/other/status/102">Quote</a><div data-testid="tweetText"><a href="https://quote.org/">Quoted article</a></div></article>'
    + '</article><article><a href="/reply/status/103">Reply</a><div data-testid="tweetText"><a href="https://reply.org/">Reply article</a></div></article>';
  const article = cleanArticle(html, social);
  expect(article?.followupLinks).toEqual([{ url: original, title: 'Article preview, not evidence' }]);
  const fetchOriginal = vi.mocked(fetchPage).getMockImplementation();
  if (!fetchOriginal || !article) throw new Error('Missing fixture');
  vi.mocked(fetchPage).mockImplementation(async url => url === social
    ? { url, canonicalUrl: url, title: article.title, content: article.content, access: 'public', metadata: { followupLinks: article.followupLinks ?? [] } }
    : fetchOriginal(url));
  const input = storyInput(3);
  input.links = [{ url: social, classification: 'relevant' }, { url: 'https://secondary.org/recap', classification: 'relevant' }];
  const docs = await researchEvidence(input, settings, { generate });
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual([social, original]);
  expect(researchDocuments(docs)[0]?.content).toBe('We measured version 2.0 ourselves.');
  expect(JSON.parse(generate.mock.calls[0]![0].prompt).document.content).not.toContain('Article preview, not evidence');
});

it.each(['empty', 'restricted'] as const)('keeps %s original followups out of summary facts and does not retry them', async failure => {
  const input = storyInput(8);
  input.links = [{ url: root, classification: 'relevant' }, { url: original, classification: 'relevant' }];
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: null,
    content: url === root ? 'A repost links to an article.' : null,
    access: url === original && failure === 'restricted' ? 'restricted' : 'public',
    metadata: url === root ? { followupLinks } : { status: failure === 'restricted' ? 401 : 200 } }));
  const docs = await researchEvidence(input, { ...settings, researchMaxSearches: 2 }, { generate });
  expect(fetchPage).toHaveBeenCalledTimes(2);
  expect(assessEvidence).toHaveBeenCalledOnce();
  expect(docs[1]).toMatchObject({ role: 'candidate', relevance: 'uncertain', content: null });
  expect(researchDocuments(docs).map(doc => doc.url)).toEqual([root]);
});

it('bounds cyclic followups and arXiv fallback reads using the same remaining allowance', async () => {
  const paper = 'https://arxiv.org/abs/2609.12345';
  const input = storyInput(8);
  input.links = [{ url: root, classification: 'relevant' }];
  vi.mocked(fetchPage).mockImplementation(async (url, allowance) => ({ url, canonicalUrl: url,
    title: 'Actual text', content: 'Read findings.', access: 'public', metadata: url === root
      ? { followupLinks: [{ url: paper, title: 'Original paper' }, ...followupLinks] }
      : { followupLinks: [{ url: root, title: 'Original article' }], representationReads: allowance ?? 1 } }));
  const docs = await researchEvidence(input, { ...settings, researchMaxPages: 3, researchMaxSearches: 2 }, { generate });
  expect(vi.mocked(fetchPage).mock.calls).toEqual([[root], [paper, 2]]);
  expect(docs).toHaveLength(2);
  expect(searchPages).not.toHaveBeenCalled();
});

it.each(['supporting', 'primary'] as const)('does not auto-promote a legacy cached Telegram %s assessment', async role => {
  const input = storyInput(3);
  input.links = [{ url: 'https://t.me/author/1', classification: 'relevant' }];
  const document = { ...evidenceDocument(), url: input.links[0]!.url, canonical_url: input.links[0]!.url,
    role, relevance: 'relevant' as const, assessment: 'Legacy assessment.' };
  vi.mocked(loadEvidence).mockResolvedValue([document]);
  const docs = await researchEvidence(input, settings, { generate });
  expect(docs[0]?.role).toBe('supporting');
  expect(researchDocuments(docs)[0]?.role).toBe('supporting');
  expect(generate).not.toHaveBeenCalled();
});

it('retains a current firsthand Telegram assessment on reuse without a platform-wide grant', async () => {
  const input = storyInput(3);
  input.links = [{ url: 'https://t.me/author/1', classification: 'relevant' }];
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: 'Our release',
    content: 'We measured version 2.0 ourselves.', access: 'public', metadata: {} }));
  const first = await researchEvidence(input, settings, { generate });
  // Only the input hash is persisted by saveEvidence; the reassessment marker is local.
  vi.mocked(loadEvidence).mockResolvedValue(first.map(document => ({ ...document,
    metadata: { researchInputHash: document.metadata?.researchInputHash } })));
  const second = await researchEvidence(input, settings, { generate });
  expect(researchDocuments(second)[0]?.role).toBe('primary');
  expect(generate).toHaveBeenCalledOnce();
  expect(saveEvidence).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
    content: 'We measured version 2.0 ourselves.', access: 'public',
  }), settings, expect.stringContaining(':read-source-v5'));
  expect(assessmentPrompt).not.toContain('ALWAYS secondary');
  expect(assessmentPrompt).toContain('Require read text establishing');
});

it('keeps a newly read Telegram repost supporting when the assessment finds no firsthand evidence', async () => {
  const input = storyInput(3);
  input.links = [{ url: 'https://t.me/repost/1', classification: 'relevant' }];
  const docs = await researchEvidence(input, settings, { generate });
  expect(docs[0]?.role).toBe('supporting');
  expect(researchDocuments(docs)[0]?.role).toBe('supporting');
});
