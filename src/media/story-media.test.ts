import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), load: vi.fn(), save: vi.fn(), release: vi.fn(),
  download: vi.fn(), dedup: vi.fn(), normalize: vi.fn(), privacy: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./cache.js', () => ({ MEDIA_TTL_MS: 604800000, MediaCache: class { load = mocks.load; save = mocks.save; release = mocks.release; } }));
vi.mock('./download.js', async original => ({ ...await original<typeof import('./download.js')>(), downloadMedia: mocks.download }));
vi.mock('./comparison.js', () => ({ deduplicateMedia: mocks.dedup, compressModelImage: mocks.normalize }));
vi.mock('./judgment.js', () => ({ judgeMedia: vi.fn() }));
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
