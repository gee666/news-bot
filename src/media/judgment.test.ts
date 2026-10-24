import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ compare: vi.fn(), compress: vi.fn(), close: vi.fn(), client: vi.fn(), failure: vi.fn() }));
vi.mock('./comparison.js', () => ({ compressModelImage: mocks.compress }));
vi.mock('../models/jev.js', () => ({ JevClient: class { close = mocks.close; } }));
vi.mock('../models/media-identity.js', () => ({ MEDIA_IDENTITY_EVIDENCE_VERSION: 'evidence-v1', compareMediaIdentity: mocks.compare }));
vi.mock('../pipeline/generation-model.js', () => ({ generationClient: mocks.client, recordGenerationFailure: mocks.failure }));
import { judgeMedia } from './judgment.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.compress.mockResolvedValue(Buffer.from('webp'));
  mocks.client.mockResolvedValue({ generateText: vi.fn() });
});

it.each(['same', 'different', 'unresolved'] as const)('preserves the explicit %s decision for cache reliability', async decision => {
  mocks.compare.mockResolvedValue({ decision });
  expect(await judgeMedia(Buffer.from('left'), Buffer.from('right'), 'story', defaultSettings)).toBe(decision);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.compare.mock.calls[0]?.[2]).toEqual([
    { data: Buffer.from('webp').toString('base64'), mimeType: 'image/webp' },
    { data: Buffer.from('webp').toString('base64'), mimeType: 'image/webp' },
  ]);
});

it('marks a model outage unresolved rather than a reliable different verdict', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mocks.compare.mockRejectedValue(new Error('provider unavailable'));
    expect(await judgeMedia(Buffer.from('a'), Buffer.from('b'), 'story', defaultSettings)).toBe('unresolved');
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Media identity comparison failed; retaining both attachments.');
  } finally { log.mockRestore(); }
});
