import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ compare: vi.fn(), compress: vi.fn(), close: vi.fn(), client: vi.fn(), failure: vi.fn(), config: vi.fn() }));
vi.mock('./comparison.js', () => ({ compressModelImage: mocks.compress }));
vi.mock('../models/jev.js', () => ({ JevClient: class {
  constructor(config: unknown) { mocks.config(config); }
  close = mocks.close;
} }));
vi.mock('../models/media-identity.js', () => ({ MEDIA_IDENTITY_VERSION: 'direct-images-v3', compareMediaIdentity: mocks.compare }));
vi.mock('../pipeline/generation-model.js', () => ({ generationClient: mocks.client, recordGenerationFailure: mocks.failure }));
import { judgeMedia, mediaJudgmentVersion } from './judgment.js';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.compress.mockResolvedValue(Buffer.from('webp'));
});

it.each(['same', 'different', 'unresolved'] as const)('preserves the explicit %s decision with JEV only', async decision => {
  mocks.compare.mockResolvedValue({ decision });
  expect(await judgeMedia(Buffer.from('left'), Buffer.from('right'), 'story', defaultSettings)).toBe(decision);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(mocks.client).not.toHaveBeenCalled();
  expect(mocks.config).toHaveBeenCalledWith(expect.objectContaining({ recordFailure: mocks.failure }));
  expect(mocks.compare.mock.calls[0]?.[1]).toEqual([
    { data: Buffer.from('webp').toString('base64'), mimeType: 'image/webp' },
    { data: Buffer.from('webp').toString('base64'), mimeType: 'image/webp' },
  ]);
  expect(mocks.compare.mock.calls[0]?.[2]).toEqual({ operationId: expect.stringMatching(/^media:story:[a-f0-9]{64}$/) });
});

it('passes the optional deadline signal to both codec operations and JEV context', async () => {
  mocks.compare.mockResolvedValue({ decision: 'same' });
  const signal = new AbortController().signal;
  const left = Buffer.from('a'); const right = Buffer.from('b');
  await judgeMedia(left, right, 'story', defaultSettings, signal);
  expect(mocks.compress).toHaveBeenCalledWith(left, { signal });
  expect(mocks.compress).toHaveBeenCalledWith(right, { signal });
  expect(mocks.compare.mock.calls[0]?.[2]).toMatchObject({ signal });
});

it('does no codec or model work for a cancelled pair and closes the client', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await judgeMedia(Buffer.from('a'), Buffer.from('b'), 'story', defaultSettings, AbortSignal.abort())).toBe('unresolved');
    expect(mocks.compress).not.toHaveBeenCalled(); expect(mocks.compare).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce(); expect(mocks.client).not.toHaveBeenCalled();
  } finally { log.mockRestore(); }
});

it('marks a model outage unresolved rather than a reliable different verdict without leaking error contents', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mocks.compare.mockRejectedValue(new Error('PRIVATE provider payload'));
    expect(await judgeMedia(Buffer.from('a'), Buffer.from('b'), 'story', defaultSettings)).toBe('unresolved');
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.client).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Media identity comparison failed; retaining both attachments.');
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE');
  } finally { log.mockRestore(); }
});

it('invalidates the description-era cache and does not depend on Pi model choices', () => {
  const version = mediaJudgmentVersion(defaultSettings);
  expect(version).toContain('direct-images-v3');
  expect(version).not.toContain('"evidence":');
  expect(mediaJudgmentVersion({ ...defaultSettings, piModel: 'another-pi-model' })).toBe(version);
  expect(mediaJudgmentVersion({ ...defaultSettings, jevModel: 'another-jev-model' })).not.toBe(version);
});
