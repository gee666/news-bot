import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { saveEvidence } from './generation-store.js';
import { fetchPage } from './research-page.js';
import { reassessEvidence } from './research.js';
import { editionPrimaries, readEditionPrimaries } from './research-edition.js';
import { evidenceDocument, storyInput } from './generation.test-helpers.js';
import type { ThreadPost } from './publication-thread.js';

vi.mock('./generation-store.js', () => ({ generationHash: () => 'hash', saveEvidence: vi.fn() }));
vi.mock('./research-page.js', () => ({ fetchPage: vi.fn() }));
vi.mock('./research.js', () => ({ reassessEvidence: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchPage).mockImplementation(async url => ({ url, canonicalUrl: url, title: 'Original',
    content: `Fresh full source ${url}`, access: 'public', metadata: {} }));
  vi.mocked(saveEvidence).mockImplementation(async (_id, page) => ({ ...evidenceDocument(),
    url: page.url, canonical_url: page.canonicalUrl, title: page.title, content: page.content, metadata: page.metadata }));
  vi.mocked(reassessEvidence).mockImplementation(async (_input, doc) => ({ ...doc, role: 'primary', relevance: 'relevant' }));
});
const post: ThreadPost = { storyId: 'old', headline: 'Old', details: 'Old summary', destinationId: 'chat', messageId: '1',
  sources: [{ label: 'Original', url: 'https://author.org/original', primary: true, access: 'public', classification: 'relevant' }] };

it('keeps primary originals across every edition but excludes publication navigation', () => {
  const navigation = { ...post.sources[0]!, url: 'https://t.me/channel/1', previousPublication: true as const };
  const result = editionPrimaries([{ ...post, sources: [...post.sources, navigation] }], [], ['https://author.org/new']);
  expect(result).toEqual({ added: ['https://author.org/new'], urls: ['https://author.org/original', 'https://author.org/new'] });
});

it('does not treat redirects, fragments, or arxiv representations as new primaries', () => {
  const doc = { ...evidenceDocument(), url: 'https://short.org/redirect', canonical_url: post.sources[0]!.url,
    role: 'primary' as const, relevance: 'relevant' as const };
  expect(editionPrimaries([post], [doc], ['https://short.org/redirect#fragment']).added).toEqual([]);
  const paper = { ...doc, url: 'https://arxiv.org/pdf/2501.12345', canonical_url: 'https://arxiv.org/abs/2501.12345' };
  expect(editionPrimaries([], [paper], ['https://arxiv.org/pdf/2501.12345']).added).toEqual([]);
  expect(editionPrimaries([], [paper], ['https://arxiv.org/abs/2501.12345v2']).added).toEqual(['https://arxiv.org/abs/2501.12345v2']);
  const versionedRead = { ...paper, metadata: { paper: { id: '2501.12345', version: 'v2', extent: 'full_text' as const } } };
  expect(editionPrimaries([], [versionedRead], ['https://arxiv.org/abs/2501.12345v2']).added).toEqual([]);
  expect(editionPrimaries([], [versionedRead], ['https://arxiv.org/abs/2501.12345v3']).added).toEqual(['https://arxiv.org/abs/2501.12345v3']);
});

it('fetches and assesses every primary anew, even above the discovery page budget', async () => {
  const urls = ['https://author.org/first', 'https://author.org/second', 'https://author.org/third'];
  const input = storyInput(); const settings = { ...defaultSettings, researchMaxPages: 1 };
  const generator = { generate: vi.fn() };
  const documents = await readEditionPrimaries(input, urls, settings, generator);
  expect(vi.mocked(fetchPage).mock.calls.map(call => call[0])).toEqual(urls);
  expect(reassessEvidence).toHaveBeenCalledTimes(3);
  expect(documents.map(doc => doc.content)).toEqual(urls.map(url => `Fresh full source ${url}`));
  expect(saveEvidence).toHaveBeenCalledWith(input.story.id, expect.anything(), settings, 'hash:edition-primary-v1');
});

it('does not silently fall back to an old summary when an original read throws', async () => {
  vi.mocked(fetchPage).mockRejectedValueOnce(new Error('crawler unavailable'));
  await expect(readEditionPrimaries(storyInput(), ['https://author.org/new'], defaultSettings, { generate: vi.fn() }))
    .rejects.toThrow('crawler unavailable');
  expect(saveEvidence).not.toHaveBeenCalled();
});

it.each([
  { access: 'unavailable' as const, content: null },
  { access: 'public' as const, content: ' ' },
  { access: 'public' as const, content: 'Just a moment... Checking your browser before accessing the site.' },
])('rejects failed or challenge primary reads rather than caching an incomplete edition: %j', async result => {
  vi.mocked(fetchPage).mockResolvedValueOnce({ url: 'https://author.org/new', canonicalUrl: null,
    title: 'Just a moment...', metadata: {}, ...result });
  await expect(readEditionPrimaries(storyInput(), ['https://author.org/new'], defaultSettings, { generate: vi.fn() }))
    .rejects.toMatchObject({ code: 'fetch_failed' });
  expect(saveEvidence).toHaveBeenCalledOnce();
  expect(reassessEvidence).not.toHaveBeenCalled();
});
