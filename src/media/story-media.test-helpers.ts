import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, vi } from 'vitest';
import { type AppSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), load: vi.fn(), save: vi.fn(), release: vi.fn(),
  download: vi.fn(), dedup: vi.fn(), normalize: vi.fn(), privacy: vi.fn(), judge: vi.fn(),
  context: vi.fn(), relevance: vi.fn(), publishable: vi.fn(), sweep: vi.fn(), pairSweep: vi.fn(), tempSweep: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./cache.js', () => ({ MEDIA_TTL_MS: 604800000, MediaCache: class { load = mocks.load; save = mocks.save; release = mocks.release; sweep = mocks.sweep; } }));
vi.mock('./download.js', async original => ({ ...await original<typeof import('./download.js')>(), downloadMedia: mocks.download }));
vi.mock('./comparison.js', () => ({ deduplicateMedia: mocks.dedup, compressModelImage: mocks.normalize, sweepComparisonTemps: mocks.tempSweep }));
vi.mock('./pair-cache.js', () => ({ MediaPairCache: class { sweep = mocks.pairSweep; } }));
vi.mock('./codec.js', () => ({ isPublishableImage: mocks.publishable }));
vi.mock('./judgment.js', () => ({ judgeMedia: mocks.judge,
  mediaJudgmentVersion: (settings: AppSettings) => JSON.stringify(settings) }));
vi.mock('../pipeline/generation-model.js', () => ({ requireInferenceApproval: mocks.privacy }));
vi.mock('./relevance.js', () => ({ loadMediaStoryContext: mocks.context, filterRelevantMedia: mocks.relevance,
  mediaRelevanceVersion: (settings: AppSettings) => `relevance-v1:${settings.piProvider}:${settings.piModel}:${settings.modelVersion}` }));
export { mocks };

export const image = { type: 'image' as const, data: Buffer.from('image'), mimeType: 'image/jpeg' };
export const video = { type: 'video' as const, data: Buffer.from('video'), mimeType: 'video/mp4' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.query.mockResolvedValue({ rows: [{ revision_id: randomUUID(), metadata: { media: [
    { type: 'image', url: 'https://example.org/a.jpg' }, { type: 'image', url: 'https://example.org/a.jpg' },
    { type: 'video', url: 'https://example.org/a.mp4' },
  ] }, source_metadata: {}, access: 'public', own_media: false }] });
  mocks.load.mockResolvedValue(null);
  mocks.release.mockResolvedValue(undefined);
  mocks.judge.mockResolvedValue('different');
  mocks.save.mockResolvedValue(Date.now() + 604800000);
  mocks.download.mockResolvedValueOnce(image).mockResolvedValueOnce(video);
  mocks.dedup.mockImplementation(async items => items);
  mocks.publishable.mockResolvedValue(true);
  mocks.normalize.mockResolvedValue(Buffer.from('png'));
  mocks.context.mockResolvedValue({ headline: 'Rocket Lab launches HawkEye 360', summary: 'Mission details', chosenExcerpt: null, mentions: [] });
  mocks.relevance.mockImplementation(async media => ({ media, resolved: true }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

