import { expect, it, vi } from 'vitest';
import { mocks, image } from './story-media.test-helpers.js';
import { randomUUID } from 'node:crypto';
import { defaultSettings } from '../settings.js';
import { publicationMedia, summaryImages, releaseStoryMedia } from './story-media.js';

function timedMedia() {
  vi.useFakeTimers();
  vi.stubEnv('MEDIA_PREPARATION_TIMEOUT_MS', '100');
}

it('bounds a never-resolving comparator, clears active work, and lets later stories and retries continue', async () => {
  timedMedia();
  const id = randomUUID();
  let finish: (decision: string) => void = () => {};
  mocks.judge.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mocks.dedup.mockImplementation(async (items, compare) => {
    await compare(image.data, image.data);
    return items;
  });
  const first = publicationMedia(id, defaultSettings);
  expect(publicationMedia(id, defaultSettings)).toBe(first);
  await vi.advanceTimersByTimeAsync(100);
  expect(await first).toEqual([]);
  expect(mocks.judge.mock.calls[0]?.[4].aborted).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.relevance).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  mocks.download.mockResolvedValue(image);
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(2);
  expect(await publicationMedia(id, defaultSettings)).toHaveLength(2);
  const saves = mocks.save.mock.calls.length;
  finish('same');
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.save).toHaveBeenCalledTimes(saves);
  expect(mocks.judge).toHaveBeenCalledTimes(3);
});

it.each(['query', 'load', 'dedup', 'relevance', 'save'] as const)('falls back to text-only on unexpected %s failure and retries cleanly', async stage => {
  timedMedia();
  const id = randomUUID();
  mocks[stage].mockRejectedValueOnce(new Error('unexpected optional-media failure'));
  expect(await publicationMedia(id, defaultSettings)).toEqual([]);
  mocks.download.mockResolvedValue(image);
  expect(await publicationMedia(id, defaultSettings)).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops the download loop on timeout and ignores a late download without caching it', async () => {
  timedMedia();
  let finish: (media: typeof image) => void = () => {};
  mocks.download.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = publicationMedia(randomUUID(), defaultSettings);
  await vi.advanceTimersByTimeAsync(100);
  expect(await task).toEqual([]);
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.download.mock.calls[0]?.[2].aborted).toBe(true);
  finish(image);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.download).toHaveBeenCalledTimes(1);
  expect(mocks.publishable).not.toHaveBeenCalled();
  expect(mocks.dedup).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('does not start downloads after a late cache read or save after late relevance', async () => {
  timedMedia();
  let finishCache: (media: null) => void = () => {};
  mocks.load.mockImplementationOnce(() => new Promise(resolve => { finishCache = resolve; }));
  const task = publicationMedia(randomUUID(), defaultSettings);
  await vi.advanceTimersByTimeAsync(100);
  expect(await task).toEqual([]);
  finishCache(null);
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.download).not.toHaveBeenCalled();
  let finishRelevance: (selection: { media: typeof image[]; resolved: boolean }) => void = () => {};
  mocks.relevance.mockImplementationOnce(() => new Promise(resolve => { finishRelevance = resolve; }));
  const next = publicationMedia(randomUUID(), defaultSettings);
  await vi.advanceTimersByTimeAsync(100);
  expect(await next).toEqual([]);
  expect(mocks.relevance.mock.calls[0]?.[4].aborted).toBe(true);
  finishRelevance({ media: [image], resolved: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.save).not.toHaveBeenCalled();
});

it('bounds a stalled source lookup and never continues with late private source rows', async () => {
  timedMedia();
  let finish: (result: { rows: unknown[] }) => void = () => {};
  mocks.query.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = publicationMedia(randomUUID(), defaultSettings);
  await vi.advanceTimersByTimeAsync(100);
  expect(await task).toEqual([]);
  finish({ rows: [{ access: 'private' }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.privacy).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
  expect(mocks.judge).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('includes summary encoding in the original total budget and starts no more encoders after expiry', async () => {
  timedMedia();
  mocks.load.mockImplementationOnce(() => new Promise(resolve => setTimeout(() => resolve([image, image]), 60)));
  let finish: (data: Buffer) => void = () => {};
  mocks.normalize.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const task = summaryImages(randomUUID(), defaultSettings);
  await vi.advanceTimersByTimeAsync(60);
  expect(mocks.normalize).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(40);
  expect(await task).toEqual([]);
  expect(mocks.normalize.mock.calls[0]?.[1].signal.aborted).toBe(true);
  finish(Buffer.from('late encoding'));
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.normalize).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('release aborts hung preparation immediately instead of awaiting its comparator', async () => {
  timedMedia();
  const id = randomUUID();
  mocks.judge.mockImplementationOnce(() => new Promise(() => {}));
  mocks.dedup.mockImplementation(async (items, compare) => { await compare(image.data, image.data); return items; });
  const task = publicationMedia(id, defaultSettings);
  await vi.advanceTimersByTimeAsync(0);
  await releaseStoryMedia(id);
  expect(await task).toEqual([]);
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(id);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds hung cache release but keeps a barrier against new saves until removal really settles', async () => {
  timedMedia();
  const id = randomUUID();
  let finish: () => void = () => {};
  mocks.release.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const release = releaseStoryMedia(id);
  await vi.advanceTimersByTimeAsync(100);
  await release;
  expect(await publicationMedia(id, defaultSettings)).toEqual([]);
  expect(mocks.query).not.toHaveBeenCalled();
  expect(await publicationMedia(randomUUID(), defaultSettings)).toHaveLength(2);
  finish();
  await vi.advanceTimersByTimeAsync(0);
  mocks.download.mockResolvedValue(image);
  expect(await publicationMedia(id, defaultSettings)).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});

it('release cancels hung summary encoding and does not start a sibling encoder', async () => {
  timedMedia();
  const id = randomUUID();
  mocks.load.mockResolvedValue([image, image]);
  mocks.normalize.mockImplementationOnce(() => new Promise(() => {}));
  const task = summaryImages(id, defaultSettings);
  await vi.advanceTimersByTimeAsync(0);
  await releaseStoryMedia(id);
  expect(await task).toEqual([]);
  expect(mocks.normalize).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
