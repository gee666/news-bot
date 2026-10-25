import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defaultSettings, type AppSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), load: vi.fn(), save: vi.fn(), release: vi.fn(),
  download: vi.fn(), dedup: vi.fn(), normalize: vi.fn(), privacy: vi.fn(), judge: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./cache.js', () => ({ MEDIA_TTL_MS: 604800000, MediaCache: class { load = mocks.load; save = mocks.save; release = mocks.release; } }));
vi.mock('./download.js', async original => ({ ...await original<typeof import('./download.js')>(), downloadMedia: mocks.download }));
vi.mock('./comparison.js', () => ({ deduplicateMedia: mocks.dedup, compressModelImage: mocks.normalize }));
vi.mock('./judgment.js', () => ({ judgeMedia: mocks.judge,
  mediaJudgmentVersion: (settings: AppSettings) => JSON.stringify(settings) }));
vi.mock('../pipeline/generation-model.js', () => ({ requireInferenceApproval: mocks.privacy }));
import { publicationMedia, summaryImages, releaseStoryMedia } from './story-media.js';

const image = { type: 'image' as const, data: Buffer.from('image'), mimeType: 'image/jpeg' };
const video = { type: 'video' as const, data: Buffer.from('video'), mimeType: 'video/mp4' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media: [
    { type: 'image', url: 'https://example.org/a.jpg' }, { type: 'image', url: 'https://example.org/a.jpg' },
    { type: 'video', url: 'https://example.org/a.mp4' },
  ] }, source_metadata: {}, access: 'public' }] });
  mocks.load.mockResolvedValue(null);
  mocks.judge.mockResolvedValue('different');
  mocks.save.mockResolvedValue(Date.now() + 604800000);
  mocks.download.mockResolvedValueOnce(image).mockResolvedValueOnce(video);
  mocks.dedup.mockImplementation(async items => items);
  mocks.normalize.mockResolvedValue(Buffer.from('png'));
});
afterEach(() => { vi.unstubAllEnvs(); });

it('downloads repeated source URLs once and persists only deduplicated media', async () => {
  const id = randomUUID();
  mocks.dedup.mockResolvedValue([image]);
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(image)]);
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.save).toHaveBeenCalledWith(id, expect.any(String), [expect.objectContaining(image)]);
  await releaseStoryMedia(id);
  expect(mocks.release).toHaveBeenCalledWith(id);
});

it('selects one original from the NVIDIA WordPress pair before downloads or visual judgment', async () => {
  const id = randomUUID();
  const url = 'https://blogs.nvidia.com/wp-content/uploads/2026/10/NVIDIA-European-Retail.jpg';
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media: [
    { type: 'image', url }, { type: 'image', url: url.replace('.jpg', '-842x450.jpg') },
  ] }, source_metadata: {}, access: 'public' }] });
  expect(await publicationMedia(id, defaultSettings)).toEqual([expect.objectContaining(image)]);
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith({ type: 'image', url }, { metadata: {} });
  expect(mocks.dedup.mock.calls[0]?.[0]).toHaveLength(1);
  expect(mocks.judge).not.toHaveBeenCalled();
  expect(mocks.privacy).toHaveBeenCalledBefore(mocks.load);
  expect(mocks.load).toHaveBeenCalledBefore(mocks.download);
  expect(mocks.save).toHaveBeenCalledWith(id, mocks.load.mock.calls[0]?.[1], [expect.objectContaining(image)]);
});

it('does not infer rendition identity across separate source revisions', async () => {
  const url = 'https://example.org/wp-content/uploads/2026/10/chart.jpg';
  mocks.query.mockResolvedValue({ rows: [url, url.replace('.jpg', '-842x450.jpg')].map(url => ({
    revision_id: randomUUID(), metadata: { media: [{ type: 'image', url }] }, source_metadata: {}, access: 'public',
  })) });
  mocks.download.mockReset().mockResolvedValue(image);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(2);
  expect(mocks.download).toHaveBeenCalledTimes(2);
  expect(mocks.dedup.mock.calls[0]?.[0]).toHaveLength(2);
});

it('excludes videos from summarization and obeys the configurable image cap', async () => {
  vi.stubEnv('MEDIA_SUMMARY_MAX_IMAGES', '2');
  mocks.dedup.mockResolvedValue([video, ...Array.from({ length: 12 }, () => image)]);
  expect(await summaryImages(randomUUID(), defaultSettings)).toEqual([
    { data: Buffer.from('png').toString('base64'), mimeType: 'image/webp' },
    { data: Buffer.from('png').toString('base64'), mimeType: 'image/webp' },
  ]);
  expect(mocks.normalize).toHaveBeenCalledTimes(2);
});

it('rejects an image cap above ten', async () => {
  vi.stubEnv('MEDIA_SUMMARY_MAX_IMAGES', '11');
  await expect(summaryImages(randomUUID(), defaultSettings)).rejects.toThrow('MEDIA_SUMMARY_MAX_IMAGES');
  expect(mocks.query).not.toHaveBeenCalled();
});

it('uses cached media without downloading and checks privacy first', async () => {
  mocks.load.mockResolvedValue([image]);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toEqual([image]);
  expect(mocks.privacy).toHaveBeenCalledWith(['public'], expect.any(String));
  expect(mocks.download).not.toHaveBeenCalled();
});

it('does not download or send private media without approval', async () => {
  mocks.privacy.mockRejectedValue(new Error('private inference forbidden'));
  await expect(publicationMedia(randomUUID(), defaultSettings)).rejects.toThrow('private inference forbidden');
  expect(mocks.download).not.toHaveBeenCalled();
});


it.each(['unresolved', 'same', 'different'])('only saves a final selection after resolved %s comparisons', async decision => {
  const id = randomUUID();
  mocks.judge.mockResolvedValue(decision);
  mocks.dedup.mockImplementation(async (items, compare) => {
    await compare(image.data, image.data);
    return items;
  });
  expect(await publicationMedia(id, defaultSettings)).toHaveLength(2);
  if (decision === 'unresolved') {
    expect(mocks.save.mock.calls[0]?.[1]).toBe(`unresolved:${mocks.load.mock.calls[0]?.[1]}`);
    // A second call must retry, not freeze the outage as a final selection.
    mocks.download.mockResolvedValue(image);
    await publicationMedia(id, defaultSettings);
    expect(mocks.judge).toHaveBeenCalledTimes(2);
  } else expect(mocks.save).toHaveBeenCalledTimes(1);
});

it('invalidates final selections when model identity changes', async () => {
  const id = randomUUID();
  await publicationMedia(id, defaultSettings);
  const first = mocks.load.mock.calls[0]?.[1];
  mocks.download.mockResolvedValue(image);
  await publicationMedia(id, { ...defaultSettings, piProvider: 'openai', piModel: 'new-vision-model' });
  expect(mocks.load.mock.calls[1]?.[1]).not.toBe(first);
});

it('keeps all attachments above the old 100-item processing cap', async () => {
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media:
    Array.from({ length: 103 }, (_, i) => ({ type: 'image', url: `https://example.org/${i}.jpg` })),
  }, source_metadata: {}, access: 'public' }] });
  mocks.download.mockReset().mockResolvedValue(image);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(103);
  expect(mocks.download).toHaveBeenCalledTimes(103);
});

it('does not impose a second seven-day retention window on retained source rows or ancestor evidence', async () => {
  await publicationMedia(randomUUID(),defaultSettings);
  const sql = mocks.query.mock.calls[0]?.[0];
  expect(sql).not.toContain("interval '7 days'");
  expect(sql).toContain('se.story_id<>$1 OR e.expires_at>now()');
  expect(sql).toContain('se.superseded_at IS NULL');
});
