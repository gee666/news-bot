import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import type { MediaCandidate } from './comparison.js';
import type { PiResult } from '../models/pi.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), compress: vi.fn(), client: vi.fn(), generate: vi.fn(),
  failure: vi.fn(), privacy: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./comparison.js', () => ({ compressModelImage: mocks.compress }));
vi.mock('../pipeline/generation-model.js', () => ({ generationClient: mocks.client,
  recordGenerationFailure: mocks.failure, requireInferenceApproval: mocks.privacy }));
import { filterRelevantMedia, loadMediaStoryContext, mediaRelevanceVersion } from './relevance.js';

const story = { headline: 'Rocket Lab launches HawkEye 360', summary: null, chosenExcerpt: null,
  mentions: ['We\'re Not Hawking Around mission'] };
const image = (name: string): MediaCandidate => ({ type: 'image', data: Buffer.from(name), mimeType: 'image/jpeg', expiresAt: 123 });
const video: MediaCandidate = { type: 'video', data: Buffer.from('video'), mimeType: 'video/mp4' };
function generation(decisions: unknown[]): PiResult {
  return { text: JSON.stringify({ decisions }), model: 'synthetic', provider: 'openai-codex', nativeSchema: true,
    durationMs: 1, usage: { input: 1, output: 1, totalTokens: 2, cacheRead: 0, cacheWrite: 0,
      cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } };
}
function decision(attachment: number, verdict = 'relevant', visibleContent = 'Matching mission patch') {
  return { attachment, decision: verdict, visibleContent,
    storyConnection: verdict === 'relevant' ? 'Named mission matches this launch' : 'Not evidence of the specific mission' };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.compress.mockImplementation(async data => data);
  mocks.client.mockResolvedValue({ generate: mocks.generate });
  mocks.generate.mockImplementation(async request => generation(request.images.map((_: unknown, i: number) => decision(i + 1))));
  mocks.query.mockResolvedValue({ rows: [{ headline: story.headline, summary: null, chosen_excerpt: null,
    mentions: [{ text: story.mentions[0], access: 'public' }] }] });
});

it('loads parameterized, story-specific extracted context without article bodies or ancestor context', async () => {
  const id = randomUUID();
  expect(await loadMediaStoryContext(id)).toEqual(story);
  const [sql, parameters] = mocks.query.mock.calls[0]!;
  expect(parameters).toEqual([id]);
  expect(sql).toContain('WHERE st.id=$1');
  expect(sql).toContain('WHERE m.story_id=st.id');
  expect(sql).toContain('i.current_revision_id=r.id');
  expect(sql).not.toContain('original_text');
  expect(sql).not.toContain('generation_story_ids');
  expect(mocks.privacy).toHaveBeenCalledWith(['public'], `media-context:${id}`);
});

it('rejects invalid IDs before querying and blocks private context even for public media', async () => {
  await expect(loadMediaStoryContext("' OR true --")).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.query.mockResolvedValue({ rows: [{ headline: story.headline, summary: null, chosen_excerpt: null,
    mentions: [{ text: 'Private fact', access: 'restricted' }] }] });
  mocks.privacy.mockRejectedValue(new Error('Private context forbidden'));
  await expect(loadMediaStoryContext(randomUUID())).rejects.toThrow('Private context forbidden');
  expect(mocks.privacy).toHaveBeenCalledWith(['restricted'], expect.any(String));
  expect(mocks.client).not.toHaveBeenCalled();
});

it.each([[], [{}], [{ headline: null, summary: null, chosen_excerpt: null, mentions: [] }]].map(rows => ({ rows })))(
  'fails closed for missing, malformed or empty context', async ({ rows }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.query.mockResolvedValue({ rows });
      const context = await loadMediaStoryContext(randomUUID());
      expect(context).toBeNull();
      expect(await filterRelevantMedia([image('logo'), video], context, randomUUID(), defaultSettings))
        .toEqual({ media: [video], resolved: false });
      expect(mocks.generate).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

it('bounds untrusted context before including it in vision prompts', async () => {
  mocks.query.mockResolvedValue({ rows: [{ headline: 'h'.repeat(3_000), summary: 's'.repeat(20_000), chosen_excerpt: null,
    mentions: Array.from({ length: 20 }, () => ({ text: 'm'.repeat(10_000), access: 'public' })) }] });
  const context = await loadMediaStoryContext(randomUUID());
  expect(context?.headline).toHaveLength(2_000);
  expect(context?.summary).toHaveLength(12_000);
  expect(context?.mentions).toHaveLength(12);
  expect(context?.mentions[0]).toHaveLength(4_000);
  expect(mocks.privacy.mock.calls[0]?.[0]).toHaveLength(20);
});

it('keeps the mission patch but rejects roundup art, boilerplate, a portrait and uncertain launch thumbnail', async () => {
  const names = ['HawkEye 360 mission patch', 'launch pad thumbnail', 'Aurora Borealis rendering',
    'SMALL ROCKETS', 'MEDIUM ROCKETS', 'HEAVY ROCKETS', 'generic rocket icon', 'author portrait', 'crow photo'];
  const candidates = names.map(image);
  mocks.generate.mockResolvedValueOnce(generation([
    decision(1, 'relevant', names[0]), decision(2, 'unresolved', names[1]),
    decision(3, 'irrelevant', names[2]), decision(4, 'irrelevant', names[3]),
  ])).mockResolvedValueOnce(generation([1, 2, 3, 4].map(index => decision(index, 'irrelevant'))))
    .mockResolvedValueOnce(generation([decision(1, 'irrelevant', names[8])]));
  const result = await filterRelevantMedia([video, ...candidates], story, randomUUID(), defaultSettings);
  expect(result).toEqual({ media: [video, candidates[0]], resolved: false });
  expect(mocks.generate).toHaveBeenCalledTimes(3);
  expect(mocks.generate.mock.calls.map(([request]) => request.images.length)).toEqual([4, 4, 1]);
  const attachments = mocks.generate.mock.calls.flatMap(([request]) => request.images);
  expect(attachments.map(item => Buffer.from(item.data, 'base64').toString())).toEqual(names);
  expect(mocks.compress).toHaveBeenCalledTimes(9);
});

it('maps reordered batch decisions by attachment number and preserves original media order and deadlines', async () => {
  const first = image('first'); const last = image('last');
  mocks.generate.mockResolvedValue(generation([decision(2), decision(1)]));
  expect(await filterRelevantMedia([first, video, last], story, randomUUID(), defaultSettings))
    .toEqual({ media: [first, video, last], resolved: true });
  expect(mocks.compress).not.toHaveBeenCalledWith(video.data);
});

it('omits images on transport failure or invalid repaired output without dropping videos', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const failure of ['transport', 'invalid']) {
      mocks.generate.mockReset();
      if (failure === 'transport') mocks.generate.mockRejectedValue(new Error('offline'));
      else mocks.generate.mockResolvedValue(generation([decision(1), decision(1)]));
      expect(await filterRelevantMedia([image('logo'), video], story, randomUUID(), defaultSettings))
        .toEqual({ media: [video], resolved: false });
    }
    expect(mocks.failure).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

it('omits a broken image but still checks other images in the batch', async () => {
  const broken = image('broken'); const patch = image('patch');
  mocks.compress.mockRejectedValueOnce(new Error('decode failure')).mockResolvedValueOnce(patch.data);
  expect(await filterRelevantMedia([broken, patch, video], story, randomUUID(), defaultSettings))
    .toEqual({ media: [patch, video], resolved: false });
  expect(mocks.generate.mock.calls[0]?.[0].images).toHaveLength(1);
});

it('retains resolved rejections and skips inference entirely for videos or no candidates', async () => {
  mocks.generate.mockResolvedValue(generation([decision(1, 'irrelevant')]));
  expect(await filterRelevantMedia([image('logo')], story, randomUUID(), defaultSettings))
    .toEqual({ media: [], resolved: true });
  mocks.client.mockClear();
  for (const candidates of [[], [video]]) {
    expect(await filterRelevantMedia(candidates, null, randomUUID(), defaultSettings))
      .toEqual({ media: candidates, resolved: true });
  }
  expect(mocks.client).not.toHaveBeenCalled();
});

it('versions the policy, image preparation and vision model identity', () => {
  const version = mediaRelevanceVersion(defaultSettings);
  expect(JSON.parse(version)).toMatchObject({ policy: 'story-visual-relevance-v1', batchSize: 4,
    provider: defaultSettings.piProvider, model: defaultSettings.piModel, modelVersion: defaultSettings.modelVersion });
  expect(mediaRelevanceVersion({ ...defaultSettings, modelVersion: defaultSettings.modelVersion + 1 })).not.toBe(version);
  expect(mediaRelevanceVersion({ ...defaultSettings, piModel: 'other' })).not.toBe(version);
});
