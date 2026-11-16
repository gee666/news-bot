import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { extractionImages } from './extraction-images.js';

const mocks = vi.hoisted(() => ({ download: vi.fn(), compress: vi.fn(), approve: vi.fn() }));
vi.mock('./download.js', async original => ({ ...await original<typeof import('./download.js')>(), downloadMedia: mocks.download }));
vi.mock('./codec.js', () => ({ compressModelImage: mocks.compress }));
vi.mock('../pipeline/generation-model.js', () => ({ requireInferenceApproval: mocks.approve }));
const source = { access: 'public', metadata: { media: [{ type: 'image', url: 'https://example.org/news.png' }] }, source_metadata: {} };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.approve.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue({ type: 'image', data: Buffer.from('raw image'), mimeType: 'image/png' });
  mocks.compress.mockResolvedValue(Buffer.from('model image'));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('extraction attachment preparation', () => {
  it('uses existing safe downloader/encoder with provenance for the exact model input', async () => {
    const [prepared] = await extractionImages(source, 'extract');
    expect(prepared?.image).toEqual({ data: Buffer.from('model image').toString('base64'), mimeType: 'image/webp' });
    expect(prepared?.provenance).toEqual({ id: 'i0', descriptor: source.metadata.media[0],
      sourceSha256: createHash('sha256').update('raw image').digest('hex'), modelSha256: createHash('sha256').update('model image').digest('hex') });
    expect(mocks.download).toHaveBeenCalledWith(source.metadata.media[0], { metadata: {} }, expect.any(AbortSignal));
    expect(mocks.compress).toHaveBeenCalledWith(Buffer.from('raw image'), { signal: expect.any(AbortSignal), maxOutputBytes: 9_000_000 });
  });
  it('checks private access before any download', async () => {
    mocks.approve.mockRejectedValue(new Error('Private inference disallowed'));
    await expect(extractionImages({ ...source, access: 'private' }, 'private')).rejects.toThrow('Private inference disallowed');
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.compress).not.toHaveBeenCalled();
  });
  it('excludes videos, known decorative images and exact duplicate descriptors', async () => {
    const prepared = await extractionImages({ ...source, metadata: { media: [
      ...source.metadata.media, ...source.metadata.media,
      { type: 'video', url: 'https://example.org/video.mp4' },
      { type: 'image', url: 'https://example.org/favicon.ico' },
    ] } }, 'filter');
    expect(prepared).toHaveLength(1);
    expect(mocks.download).toHaveBeenCalledOnce();
  });
  it('never silently truncates images at the configured count limit', async () => {
    vi.stubEnv('MEDIA_EXTRACTION_MAX_IMAGES', '1');
    await expect(extractionImages({ ...source, metadata: { media: [...source.metadata.media,
      { type: 'image', url: 'https://example.org/another.png' }] } }, 'count')).rejects.toThrow('count exceeds limit');
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('enforces cumulative downloaded and encoded byte limits', async () => {
    vi.stubEnv('MEDIA_EXTRACTION_MAX_BYTES', '5');
    await expect(extractionImages(source, 'bytes')).rejects.toThrow('download exceeds limit');
    expect(mocks.compress).not.toHaveBeenCalled();
    mocks.download.mockResolvedValue({ type: 'image', data: Buffer.from('raw'), mimeType: 'image/png' });
    await expect(extractionImages(source, 'encoded-bytes')).rejects.toThrow('model image bytes exceed limit');
  });
  it.each(['download', 'compress'] as const)('fails instead of returning [] on %s failure', async step => {
    mocks[step].mockRejectedValue(new Error('Attachment unavailable'));
    await expect(extractionImages(source, 'failed')).rejects.toThrow('Attachment unavailable');
  });
  it('rejects malformed image descriptors instead of treating them as absent', async () => {
    await expect(extractionImages({ ...source, metadata: { media: [{ type: 'image', telegramMessageId: -1 }] } }, 'invalid')).rejects.toThrow();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it('settles uncooperative I/O on the shared media deadline without starting encoding', async () => {
    vi.useFakeTimers(); vi.stubEnv('MEDIA_PREPARATION_TIMEOUT_MS', '50');
    mocks.download.mockImplementation(() => new Promise(() => {}));
    const task = expect(extractionImages(source, 'timeout')).rejects.toThrow('deadline expired');
    await vi.advanceTimersByTimeAsync(51);
    await task;
    expect(mocks.compress).not.toHaveBeenCalled();
    expect(mocks.download.mock.calls[0]?.[2].aborted).toBe(true);
  });
});
