import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import type { MediaCandidate } from './comparison.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), compress: vi.fn(), judge: vi.fn(), close: vi.fn(),
  failure: vi.fn(), privacy: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./comparison.js', () => ({ compressModelImage: mocks.compress }));
vi.mock('../models/jev.js', () => ({ JevClient: class { judge = mocks.judge; close = mocks.close; } }));
vi.mock('../pipeline/generation-model.js', () => ({ recordGenerationFailure: mocks.failure,
  requireInferenceApproval: mocks.privacy }));
import { filterRelevantMedia, loadMediaStoryContext, mediaRelevanceVersion } from './relevance.js';

const story = { headline: 'Rocket Lab launches HawkEye 360', summary: null, chosenExcerpt: null,
  mentions: ['We\'re Not Hawking Around mission'] };
const image = (name: string): MediaCandidate => ({ type: 'image', data: Buffer.from(name), mimeType: 'image/jpeg', expiresAt: 123 });
const video: MediaCandidate = { type: 'video', data: Buffer.from('video'), mimeType: 'video/mp4' };
const webp = Buffer.from('UklGRnAAAABXRUJQVlA4IGQAAAAQBwCdASqAAIAAPjEYi0SiIaEQRAAgAwS0t3C6TLgPwA/AAAC1YSrOcgjYgqOe2IvEFRz2xF4gqOe2IvEFRz2wuAD+/zwb//+xmP2jP8kr//+DMfwZj+DMf/CfGxI0QAAAAAAA', 'base64');
const result = (choice = 'relevant') => ({ answers: { relation: { type: 'choice', choice } } });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.compress.mockResolvedValue(webp);
  mocks.judge.mockResolvedValue(result());
  mocks.query.mockResolvedValue({ rows: [{ headline: story.headline, summary: null, chosen_excerpt: null,
    mentions: [{ text: story.mentions[0], access: 'public' }] }] });
});

it('loads parameterized story-specific context without parent article bodies or ancestors', async () => {
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

it('rejects invalid IDs and private context before any model request', async () => {
  await expect(loadMediaStoryContext("' OR true --")).rejects.toThrow();
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.query.mockResolvedValue({ rows: [{ headline: story.headline, summary: null, chosen_excerpt: null,
    mentions: [{ text: 'Private fact', access: 'restricted' }] }] });
  mocks.privacy.mockRejectedValue(new Error('Private context forbidden'));
  await expect(loadMediaStoryContext(randomUUID())).rejects.toThrow('Private context forbidden');
  expect(mocks.privacy).toHaveBeenCalledWith(['restricted'], expect.any(String));
  expect(mocks.judge).not.toHaveBeenCalled();
});

it.each([[], [{}], [{ headline: null, summary: null, chosen_excerpt: null, mentions: [] }]].map(rows => ({ rows })))(
  'omits images with missing or malformed context, without dropping videos', async ({ rows }) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mocks.query.mockResolvedValue({ rows });
      const context = await loadMediaStoryContext(randomUUID());
      expect(context).toBeNull();
      expect(await filterRelevantMedia([image('logo'), video], context, randomUUID(), defaultSettings))
        .toEqual({ media: [video], resolved: false });
      expect(mocks.judge).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

it('bounds untrusted context and checks all source access labels', async () => {
  mocks.query.mockResolvedValue({ rows: [{ headline: 'h'.repeat(3_000), summary: 's'.repeat(20_000), chosen_excerpt: null,
    mentions: Array.from({ length: 20 }, () => ({ text: 'm'.repeat(10_000), access: 'public' })) }] });
  const context = await loadMediaStoryContext(randomUUID());
  expect(context?.headline).toHaveLength(2_000);
  expect(context?.summary).toHaveLength(12_000);
  expect(context?.mentions).toHaveLength(12);
  expect(context?.mentions[0]).toHaveLength(4_000);
  expect(mocks.privacy.mock.calls[0]?.[0]).toHaveLength(20);
});

it('uses JEV pixels for each image and preserves only positively relevant attachments in order', async () => {
  const names = ['mission patch', 'uncertain launch pad', 'roundup art', 'category badge', 'author portrait'];
  const candidates = names.map(image);
  mocks.judge.mockResolvedValueOnce(result('relevant')).mockResolvedValueOnce(result('unresolved'))
    .mockResolvedValue(result('irrelevant'));
  expect(await filterRelevantMedia([video, ...candidates], story, randomUUID(), defaultSettings))
    .toEqual({ media: [video, candidates[0]], resolved: false });
  expect(mocks.judge).toHaveBeenCalledTimes(5);
  expect(mocks.judge.mock.calls.map(call => call[3].length)).toEqual([1, 1, 1, 1, 1]);
  const attachments = mocks.judge.mock.calls.flatMap(call => call[3]);
  expect(attachments).toEqual(names.map(() => ({ data: webp.toString('base64'), mimeType: 'image/webp' })));
  expect(mocks.compress.mock.calls.map(call => call[0].toString())).toEqual(names);
  expect(mocks.judge.mock.calls[0]?.[1]).toEqual({ story });
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('omits images on model failure without blocking healthy siblings or videos', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const first = image('bad'); const second = image('good');
    mocks.judge.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result());
    expect(await filterRelevantMedia([first, second, video], story, randomUUID(), defaultSettings))
      .toEqual({ media: [second, video], resolved: false });
    expect(mocks.close).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

it('omits malformed decisions rather than calling another model for repair', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mocks.judge.mockResolvedValue(result('maybe'));
    expect(await filterRelevantMedia([image('bad'), video], story, randomUUID(), defaultSettings))
      .toEqual({ media: [video], resolved: false });
    expect(mocks.judge).toHaveBeenCalledOnce();
  } finally { log.mockRestore(); }
});

it('omits a broken encoding but still checks a healthy image', async () => {
  const broken = image('broken'); const patch = image('patch');
  mocks.compress.mockRejectedValueOnce(new Error('decode failure')).mockResolvedValueOnce(webp);
  expect(await filterRelevantMedia([broken, patch, video], story, randomUUID(), defaultSettings))
    .toEqual({ media: [patch, video], resolved: false });
  expect(mocks.judge).toHaveBeenCalledOnce();
});

it('skips inference for videos and preserves resolved rejections', async () => {
  mocks.judge.mockResolvedValue(result('irrelevant'));
  expect(await filterRelevantMedia([image('logo')], story, randomUUID(), defaultSettings))
    .toEqual({ media: [], resolved: true });
  mocks.judge.mockClear();
  for (const candidates of [[], [video]]) {
    expect(await filterRelevantMedia(candidates, null, randomUUID(), defaultSettings))
      .toEqual({ media: candidates, resolved: true });
  }
  expect(mocks.judge).not.toHaveBeenCalled();
});

it('propagates the deadline and stops before the next image on cancellation', async () => {
  const controller = new AbortController();
  mocks.judge.mockImplementationOnce(async () => { controller.abort(); return result(); });
  await expect(filterRelevantMedia([image('first'), image('second')], story, randomUUID(), defaultSettings, controller.signal))
    .rejects.toThrow();
  expect(mocks.judge).toHaveBeenCalledOnce();
  expect(mocks.judge.mock.calls[0]?.[2].signal).toBe(controller.signal);
  expect(mocks.compress.mock.calls[0]?.[1].signal).toBe(controller.signal);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it('does not approve context after a query outlives the deadline', async () => {
  const controller = new AbortController();
  mocks.query.mockImplementationOnce(async () => { controller.abort(); return { rows: [] }; });
  await expect(loadMediaStoryContext(randomUUID(), controller.signal)).rejects.toThrow();
  expect(mocks.privacy).not.toHaveBeenCalled();
});

it('versions JEV policy and model identity independently of OpenAI', () => {
  const version = mediaRelevanceVersion(defaultSettings);
  expect(JSON.parse(version)).toMatchObject({ policy: 'story-visual-relevance-v2-direct-jev', batchSize: 1,
    endpoint: defaultSettings.jevUrl, model: defaultSettings.jevModel, modelVersion: defaultSettings.modelVersion });
  expect(mediaRelevanceVersion({ ...defaultSettings, modelVersion: defaultSettings.modelVersion + 1 })).not.toBe(version);
  expect(mediaRelevanceVersion({ ...defaultSettings, jevModel: 'other' })).not.toBe(version);
  expect(mediaRelevanceVersion({ ...defaultSettings, piModel: 'other' })).toBe(version);
});
