import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { researchStory } from './generation.js';
import { saveGenerations } from './generation-store.js';
import { generationClient } from './generation-model.js';
import { readEditionPrimaries } from './research-edition.js';
import { evidenceDocument, modelResult, secondId, storyId, storyInput } from './generation.test-helpers.js';

const mocks = vi.hoisted(() => ({ input: vi.fn(), generate: vi.fn(), query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('../media/story-media.js', () => ({ summaryImages: vi.fn(async () => []) }));
vi.mock('./generation-store.js', () => ({
  publishedStory: vi.fn(async () => null), loadStory: mocks.input, alreadyGenerated: vi.fn(async () => false),
  evidenceSnapshotHash: async () => 'evidence-signature', saveGenerations: vi.fn(),
  loadCurrentEvidence: async () => [], loadPreviousEvidence: async () => [],
}));
vi.mock('./generation-model.js', async original => ({
  ...await original<typeof import('./generation-model.js')>(), generationClient: vi.fn(), recordGenerationFailure: vi.fn(),
}));
vi.mock('./publication-thread.js', () => ({ publishedThread: vi.fn(async () => []), rebaseFollowup: vi.fn() }));
vi.mock('./research-edition.js', async original => ({
  ...await original<typeof import('./research-edition.js')>(), readEditionPrimaries: vi.fn(),
}));

const draft = { headline: 'Acme выпустила версию 2.0', summary: 'Версия быстрее и доступна для коммерческого использования.',
  source_urls: ['https://example.org/release'] };
const passed = { remarks: [] };
const previous = { storyId: secondId, headline: 'Предыдущий заголовок', details: 'Старые сведения',
  destinationId: '-100123', messageId: '644', sources: [] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.generate.mockReset();
  vi.mocked(readEditionPrimaries).mockImplementation(async () => [evidenceDocument()]);
  vi.mocked(generationClient).mockResolvedValue({ generate: (request, context) => request.responseSchema?.name === 'source_origins'
    ? Promise.resolve(modelResult({ primary_urls: [] })) : mocks.generate(request, context) });
});

const joinedBranchId = '55555555-5555-4555-8555-555555555555';
function joinedBranchInput(withPrimary: boolean) {
  const input = storyInput();
  const sources = withPrimary ? [{ label: 'Original', url: 'https://example.org/release', primary: true,
    access: 'public' as const, classification: 'relevant' as const }] : [];
  input.previous_posts = [{ ...previous, sources }, { ...previous, storyId: joinedBranchId,
    messageId: '645', details: 'Последняя публикация не описывала условия лицензии.', sources }];
  input.mentions.push({ ...input.mentions[0]!, id: joinedBranchId, text: 'Полный отчет другой ветки: лицензия допускает коммерческое использование.' });
  return input;
}

it.each([true, false])('rebuilds newly joined published branches without coverage, even with no new primary: %s', async withPrimary => {
  const input = joinedBranchInput(withPrimary);
  mocks.input.mockResolvedValueOnce(input);
  mocks.generate.mockResolvedValueOnce(modelResult(draft)).mockResolvedValueOnce(modelResult(passed));
  await researchStory(storyId, defaultSettings);
  expect(readEditionPrimaries).toHaveBeenCalledWith(input, withPrimary ? ['https://example.org/release'] : [], defaultSettings, expect.anything());
  expect(mocks.generate).toHaveBeenCalledTimes(2);
  const material = JSON.parse(mocks.generate.mock.calls[0]?.[0].prompt);
  expect(material.mentions).toContainEqual(expect.objectContaining({ text: input.mentions[1]!.text }));
  expect(material).not.toHaveProperty('previous_posts');
  expect(saveGenerations).toHaveBeenCalledWith([input], [expect.objectContaining({
    summary: draft.summary, coveredPublishedStoryIds: [secondId, joinedBranchId],
  })], defaultSettings);
});

it('reuses a combined published edition only when its pinned receipt covers every other branch', async () => {
  const input = joinedBranchInput(true);
  mocks.input.mockResolvedValueOnce(input);
  mocks.query.mockResolvedValueOnce({ rows: [{ coverage: [secondId] }] });
  await researchStory(storyId, defaultSettings);
  expect(readEditionPrimaries).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(saveGenerations).toHaveBeenCalledWith([input], [expect.objectContaining({
    headline: previous.headline, summary: input.previous_posts?.[1]?.details,
    coveredPublishedStoryIds: [secondId, joinedBranchId],
  })], defaultSettings);
});

it('does not fall back to an incomplete branch summary when the joined rebuild cannot read an original', async () => {
  mocks.input.mockResolvedValueOnce(joinedBranchInput(true));
  vi.mocked(readEditionPrimaries).mockRejectedValueOnce(new Error('Original unavailable'));
  await expect(researchStory(storyId, defaultSettings)).rejects.toThrow('Original unavailable');
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(saveGenerations).not.toHaveBeenCalled();
});

