import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiRequest } from '../models/pi.js';
import { defaultSettings } from '../settings.js';
import { researchDocuments, researchEvidence, researchMentions } from './research.js';
import { assessEvidence, loadEvidence, saveEvidence } from './generation-store.js';
import { fetchPage, searchPages } from './research-page.js';
import { ResearchFetchError } from './research-fetch.js';
import { evidenceDocument, evidenceId, modelResult, storyId, storyInput } from './generation.test-helpers.js';

vi.mock('../db.js', () => ({ db: { query: vi.fn().mockResolvedValue({ rows: [] }) } }));
vi.mock('./generation-store.js', async importOriginal => ({
  ...await importOriginal<typeof import('./generation-store.js')>(),
  assessEvidence: vi.fn(), loadEvidence: vi.fn(), saveEvidence: vi.fn(),
}));
vi.mock('./research-page.js', () => ({ fetchPage: vi.fn(), searchPages: vi.fn() }));
const generate = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ALLOW_PRIVATE_INFERENCE', 'false');
  vi.stubEnv('RESEARCH_PREFERRED_DOMAINS', '');
  vi.mocked(loadEvidence).mockResolvedValue([]);
  vi.mocked(searchPages).mockResolvedValue([]);
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url,
    title: 'Release 2.0', content: 'Acme announces version 2.0.', access: 'public', metadata: {} }));
  vi.mocked(saveEvidence).mockImplementation(async (_id, page) => ({ ...evidenceDocument(), url: page.url,
    canonical_url: page.canonicalUrl, title: page.title, content: page.content, access: page.access }));
  vi.mocked(assessEvidence).mockImplementation(async (_id, document, role, assessment, _settings, relevance) => ({ ...document, role, assessment, relevance }));
  generate.mockImplementation(async (request: PiRequest) => {
    if (request.responseSchema?.name === 'research_queries') return modelResult({ queries: ['Acme 2.0 release'] });
    const state = JSON.parse(request.prompt);
    return modelResult({ evidence_id: state.document.evidence_id, role: 'primary', relevance: 'relevant', reason: 'Оригинальное заявление разработчика.' });
  });
});
afterEach(() => vi.unstubAllEnvs());

describe('bounded evidence research', () => {
  it('charges failed reads to the configured page budget without discarding collected links', async () => {
    const input = storyInput(3);
    input.links = [
      { url: 'https://openai.com/blocked', classification: 'relevant' },
      { url: 'https://openai.com/second-blocked', classification: 'relevant' },
      { url: 'https://openai.com/alternate', classification: 'relevant' },
      { url: 'https://openai.com/recap', classification: 'relevant' },
      { url: 'https://dslab.tech/model', classification: 'relevant' },
    ];
    const links = structuredClone(input.links);
    vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: null,
      content: url.includes('blocked') ? null : 'Announcement', access: url.includes('blocked') ? 'restricted' : 'public',
      metadata: { status: url.includes('blocked') ? 403 : 200 } }));
    const result = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 2 }, { generate });
    expect(result).toHaveLength(2);
    expect(result.filter(doc => doc.content)).toHaveLength(0);
    expect(fetchPage).not.toHaveBeenCalledWith('https://openai.com/alternate');
    expect(fetchPage).not.toHaveBeenCalledWith('https://dslab.tech/model');
    expect(input.links).toEqual(links);
  });

  it.each([[2, 2], [10, 10]])('bounds unsuccessful fetches for %s pages to %s', async (researchMaxPages, count) => {
    const input = storyInput(9);
    input.links = Array.from({ length: 40 }, (_, index) => ({
      url: `https://publisher.org/${index}`, classification: 'relevant' as const }));
    vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: null, title: null, content: null,
      access: 'restricted', metadata: { status: 403 } }));
    expect(await researchEvidence(input, { ...defaultSettings, researchMaxPages, researchMaxSearches: 0 }, { generate }))
      .toHaveLength(count);
    expect(fetchPage).toHaveBeenCalledTimes(count);
    expect(input.links).toHaveLength(40);
  });

  it('prefers configured publisher hosts and subdomains without granting primary authority', async () => {
    vi.stubEnv('RESEARCH_PREFERRED_DOMAINS', ' openai.com, another.org ');
    const input = storyInput(3);
    input.links = [
      { url: 'https://dslab.tech/model', classification: 'relevant' },
      { url: 'https://openai.com.attacker.org/model', classification: 'relevant' },
      { url: 'https://openai.com/release', classification: 'relevant' },
      { url: 'https://help.openai.com/terms', classification: 'relevant' },
      { url: 'https://openai.com/uncertain', classification: 'uncertain' },
    ];
    generate.mockResolvedValue(modelResult({ evidence_id: evidenceId, role: 'supporting', relevance: 'relevant', reason: 'Фоновый материал.' }));
    const result = await researchEvidence(input, defaultSettings, { generate });
    expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual([
      'https://openai.com/release', 'https://help.openai.com/terms']);
    expect(result.every(doc => doc.role === 'supporting')).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(input.links).toHaveLength(5);
  });

  it('deduplicates normalized URL variants and final redirect URLs', async () => {
    const input = storyInput(3);
    input.links = [
      { url: 'https://EXAMPLE.org:443/release#one', classification: 'relevant' },
      { url: 'https://example.org/release#two', classification: 'relevant' },
      { url: 'https://example.org/final', classification: 'relevant' },
    ];
    vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: 'https://example.org/final',
      title: null, content: 'Release', access: 'public', metadata: {} }));
    expect(await researchEvidence(input, defaultSettings, { generate })).toHaveLength(1);
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it('accepts a freshly read Telegram announcement only after firsthand assessment', async () => {
    const input = storyInput(3);
    input.links = [{ url: 'https://t.me/company/123', classification: 'relevant' }];
    const documents = await researchEvidence(input, defaultSettings, { generate });
    expect(documents[0]?.role).toBe('primary');
    expect(assessEvidence).toHaveBeenCalledOnce();
    expect(researchDocuments(documents)[0]?.role).toBe('primary');
  });

  it('downgrades stale Telegram primary assessments without repeating inference', async () => {
    const input = storyInput(3);
    input.links = [{ url: 'https://t.me/company/123', classification: 'relevant' }];
    const document = { ...evidenceDocument(), url: input.links[0]!.url, canonical_url: input.links[0]!.url,
      role: 'primary' as const, relevance: 'relevant' as const, assessment: 'Старое решение.' };
    vi.mocked(loadEvidence).mockResolvedValue([document]);
    expect((await researchEvidence(input, defaultSettings, { generate }))[0]?.role).toBe('supporting');
    expect(generate).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(researchDocuments([document])[0]?.role).toBe('supporting');
  });

  it('passes actual retrieval and publisher metadata through document excerpts', () => {
    const document = { ...evidenceDocument(), role: 'supporting' as const, relevance: 'relevant' as const, published_at: '2026-09-29T00:00:00Z',
      updated_at: null, fetched_at: '2026-10-01T00:00:00Z',
      metadata: { method: 'crawl4ai' as const, contentFormat: 'markdown' as const, status: 200 } };
    expect(researchDocuments([document])[0]).toMatchObject({
      published_at: document.published_at, updated_at: null, fetched_at: document.fetched_at,
      method: 'crawl4ai', contentFormat: 'markdown', access: 'public', metadata: { status: 200 } });
    expect(researchDocuments([{ ...evidenceDocument(), role: 'supporting', relevance: 'relevant' }])[0]).toMatchObject({
      published_at: null, updated_at: null, fetched_at: null });
  });

  it('persists fetched evidence before assessment and stores story-specific primary status', async () => {
    const input = storyInput(8);
    const result = await researchEvidence(input, defaultSettings, { generate });
    expect(fetchPage).toHaveBeenCalledWith('https://example.org/release');
    expect(saveEvidence).toHaveBeenCalledWith(storyId, expect.objectContaining({ access: 'public' }), defaultSettings, expect.any(String));
    expect(assessEvidence).toHaveBeenCalledWith(storyId, expect.objectContaining({ id: evidenceId }), 'primary',
      'Оригинальное заявление разработчика.', defaultSettings, 'relevant');
    expect(result[0]).toMatchObject({ role: 'primary', assessment: 'Оригинальное заявление разработчика.' });
    expect(vi.mocked(saveEvidence).mock.invocationCallOrder[0]).toBeLessThan(generate.mock.invocationCallOrder[0] ?? Infinity);
    expect(searchPages).toHaveBeenCalledOnce();
    expect(JSON.parse(generate.mock.calls[0]![0].prompt).document).toMatchObject({ evidence_id: evidenceId, content: 'Acme announces version 2.0.' });
  });

  it('resumes a fetched page without refetching and repairs an incorrect evidence ID', async () => {
    vi.mocked(loadEvidence).mockResolvedValue([evidenceDocument()]);
    generate.mockResolvedValueOnce(modelResult({ evidence_id: storyId, role: 'primary', relevance: 'relevant', reason: 'Ошибка.' }))
      .mockResolvedValueOnce(modelResult({ evidence_id: evidenceId, role: 'supporting', relevance: 'relevant', reason: 'Вторичный отчет.' }));
    const result = await researchEvidence(storyInput(8), { ...defaultSettings, researchMaxSearches: 0 }, { generate });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(saveEvidence).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(result[0]?.role).toBe('supporting');
  });

  it('reuses completed assessments and keeps unavailable links as unverified candidates', async () => {
    vi.mocked(loadEvidence).mockResolvedValue([{ ...evidenceDocument(), role: 'primary', assessment: 'Проверено.' }]);
    const input = storyInput(8);
    input.links.push({ url: 'https://example.org/login', classification: 'uncertain' });
    vi.mocked(fetchPage).mockResolvedValue({ url: 'https://example.org/login', canonicalUrl: null, title: null,
      content: null, access: 'restricted', metadata: { status: 403 } });
    const result = await researchEvidence(input, defaultSettings, { generate });
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ role: 'candidate', access: 'restricted', content: null });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].responseSchema.name).toBe('research_queries');
  });

  it('bounds total pages and deduplicates URLs across retained relevant and uncertain links', async () => {
    const input = storyInput(8);
    input.links.push({ url: 'https://example.org/release', classification: 'uncertain' },
      { url: 'https://example.org/second', classification: 'uncertain' },
      { url: 'https://example.org/third', classification: 'relevant' });
    const result = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 2 }, { generate });
    expect(result).toHaveLength(2);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(searchPages).toHaveBeenCalledOnce();
  });

  it('searches only when primary evidence is missing and visits bounded search results', async () => {
    const input = storyInput(8);
    generate.mockImplementation(async (request: PiRequest) => request.responseSchema?.name === 'research_queries'
      ? modelResult({ queries: ['Acme 2.0 release'] }) : modelResult({
        evidence_id: JSON.parse(request.prompt).document.evidence_id, role: 'supporting', relevance: 'relevant', reason: 'Вторичный отчет.' }));
    vi.mocked(searchPages).mockResolvedValue(['https://primary.org/one', 'https://primary.org/two']);
    const result = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 2 }, { generate });
    expect(result).toHaveLength(2);
    expect(searchPages).toHaveBeenCalledOnce();
    expect(searchPages).toHaveBeenCalledWith('Acme 2.0 release', 1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('enforces search counts and allows unavailable optional search without inventing evidence', async () => {
    const input = storyInput(8);
    input.links = [];
    input.story.chosen_excerpt = 'Distinct query for event';
    vi.mocked(searchPages).mockRejectedValue(new ResearchFetchError('fetch_failed'));
    expect(await researchEvidence(input, { ...defaultSettings, researchMaxSearches: 1 }, { generate })).toEqual([]);
    expect(searchPages).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each(['restricted', 'unknown'] as const)('blocks %s mentions before page fetching or search', async access => {
    const input = storyInput(8);
    input.mentions[0]!.access = access;
    await expect(researchEvidence(input, defaultSettings, { generate })).rejects.toMatchObject({ metadata: { kind: 'invalid_request' } });
    expect(loadEvidence).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(searchPages).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('blocks private source-only link provenance before fetch or search', async () => {
    const input = storyInput(3);
    input.links[0]!.access = 'restricted';
    await expect(researchEvidence(input, defaultSettings, { generate })).rejects.toMatchObject({ metadata: { kind: 'invalid_request' } });
    expect(loadEvidence).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
    expect(searchPages).not.toHaveBeenCalled();
  });

  it('blocks retained unknown evidence content before assessment', async () => {
    vi.mocked(loadEvidence).mockResolvedValue([{ ...evidenceDocument(), access: 'unknown' }]);
    await expect(researchEvidence(storyInput(8), defaultSettings, { generate })).rejects.toMatchObject({ metadata: { kind: 'invalid_request' } });
    expect(generate).not.toHaveBeenCalled();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('keeps evidence unverified after failed optional assessment without blocking generation', async () => {
    generate.mockResolvedValue(modelResult({ evidence_id: evidenceId, role: 'trusted', relevance: 'uncertain', reason: 'Выдуманный статус.' }));
    const result = await researchEvidence(storyInput(3), defaultSettings, { generate });
    expect(result[0]?.role).toBe('candidate');
    expect(saveEvidence).toHaveBeenCalledOnce();
    expect(assessEvidence).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([1, 3])('uses only supplied links for score %s and keeps its effort bounded', async score => {
    const input = storyInput(score);
    input.links = [
      { url: 'https://t.me/channel/1', classification: 'relevant' },
      { url: 'https://vendor.org/announcement', classification: 'relevant' },
      { url: 'https://secondary.org/story', classification: 'relevant' },
    ];
    generate.mockImplementation(async (request: PiRequest) => request.responseSchema?.name === 'research_queries'
      ? modelResult({ queries: ['Acme 2.0 release', 'Acme release notes'] })
      : modelResult({ evidence_id: evidenceId, role: 'candidate', relevance: 'uncertain', reason: 'Другая версия продукта.' }));
    vi.mocked(searchPages).mockResolvedValue(['https://vendor.org/release-notes']);
    const documents = await researchEvidence(input, { ...defaultSettings, researchMaxPages: 10, researchMaxSearches: 5 }, { generate });
    expect(vi.mocked(fetchPage).mock.calls[0]?.[0]).toBe('https://vendor.org/announcement');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(searchPages).not.toHaveBeenCalled();
    expect(vi.mocked(fetchPage).mock.calls[1]?.[0]).toBe('https://secondary.org/story');
    expect(documents.every(document => document.role === 'candidate')).toBe(true);
  });

  it('does no fallback search or model work for a low-score story without links', async () => {
    const input = storyInput(1);
    input.links = [];
    expect(await researchEvidence(input, defaultSettings, { generate })).toEqual([]);
    expect(fetchPage).not.toHaveBeenCalled();
    expect(searchPages).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('preserves relevant and uncertain link classifications when fetching fails', async () => {
    const input = storyInput(3);
    input.links.push({ url: 'https://example.org/blocked', classification: 'uncertain' });
    const links = structuredClone(input.links);
    vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: null, title: null,
      content: null, access: 'unavailable', metadata: { error: 'fetch_failed' } }));
    const documents = await researchEvidence(input, defaultSettings, { generate });
    expect(documents).toHaveLength(2);
    expect(input.links).toEqual(links);
    expect(documents.every(document => document.role === 'candidate')).toBe(true);
    expect(assessEvidence).not.toHaveBeenCalled();
    expect(searchPages).not.toHaveBeenCalled();
  });

  it('reserves discovery budget even when supplied supporting links could fill all slots', async () => {
    const input = storyInput(9);
    input.links.push({ url: 'https://example.org/second', classification: 'relevant' });
    generate.mockImplementation(async (request: PiRequest) => request.responseSchema?.name === 'research_queries'
      ? modelResult({ queries: ['Acme official release'] })
      : modelResult({ evidence_id: evidenceId, role: 'supporting', relevance: 'relevant', reason: 'Полезная документация.' }));
    vi.mocked(searchPages).mockResolvedValue(['https://author.org/release']);
    await researchEvidence(input, { ...defaultSettings, researchMaxPages: 2 }, { generate });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage).toHaveBeenLastCalledWith('https://author.org/release');
    expect(searchPages).toHaveBeenCalledOnce();
  });

  it('keeps complete research documents and their assessments', () => {
    const documents = Array.from({ length: 20 }, () => ({ ...evidenceDocument(), role: 'supporting' as const, relevance: 'relevant' as const, content: 'x'.repeat(30_000) }));
    const excerpts = researchDocuments(documents);
    expect(excerpts).toHaveLength(20);
    expect(excerpts.reduce((total, excerpt) => total + excerpt.content.length, 0)).toBe(600_000);
    expect(excerpts.every(excerpt => !excerpt.truncated && excerpt.role === 'supporting')).toBe(true);
  });

  it('orders reports by publication time and labels collection fallback explicitly', () => {
    const input=storyInput(7);
    const base=input.mentions[0]!;
    input.mentions=[
      {...base,id:'release',text:'Company released Agent.',published_at:'2026-09-29T17:10:02Z',collected_at:'2026-09-30T08:00:00Z'},
      {...base,id:'rumor',text:'Rumor: Agent may launch.',published_at:'2026-09-29T16:28:18Z',collected_at:'2026-09-30T09:00:00Z'},
      {...base,id:'fallback',published_at:null,collected_at:'2026-09-29T18:00:00Z'},
    ];
    const result=researchMentions(input);
    expect(result.map(mention=>mention.id)).toEqual(['rumor','release','fallback']);
    expect(result[1]).toMatchObject({reported_at:'2026-09-29T17:10:02Z',time_basis:'published'});
    expect(result[2]).toMatchObject({published_at:null,reported_at:'2026-09-29T18:00:00Z',time_basis:'collected'});
    expect(researchMentions(storyInput())[0]).toMatchObject({reported_at:null,time_basis:'unknown'});
  });

  it('keeps all mention text without a model-size budget', () => {
    const input = storyInput(8);
    input.mentions = Array.from({ length: 10 }, (_, index) => ({ ...input.mentions[0]!, text: String(index).repeat(10_000) }));
    const snippets = researchMentions(input);
    expect(snippets.reduce((total, snippet) => total + snippet.text.length, 0)).toBe(100_000);
    expect(snippets.map(snippet => snippet.text)).toEqual(input.mentions.map(mention => mention.text));
  });
});
