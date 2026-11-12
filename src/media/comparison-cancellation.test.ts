import { expect, it, vi } from 'vitest';
import { deduplicateMedia, type MediaCandidate, type MediaCommandRunner } from './comparison.js';

const candidates: MediaCandidate[] = ['first', 'second', 'third'].map(text => ({ type: 'image', data: Buffer.from(text), mimeType: 'image/jpeg' }));
const run: MediaCommandRunner = async (_command, args, input) => args.includes('rawvideo')
  ? Buffer.alloc(1024, 120) : Buffer.from(`png:${input?.toString()}`);

it('terminates the sequential loop when a judge hangs, without starting more comparisons on late completion', async () => {
  const controller = new AbortController();
  let finish: (decision: false) => void = () => {};
  let started: () => void = () => {};
  const ready = new Promise<void>(resolve => { started = resolve; });
  const judge = vi.fn(() => new Promise<false>(resolve => { finish = resolve; started(); }));
  const task = deduplicateMedia(candidates, judge, { run, signal: controller.signal });
  const failed = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  await ready;
  controller.abort();
  await failed;
  finish(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(judge).toHaveBeenCalledTimes(1);
});

it('cancels a hung decoder without starting the other image decoder or judge', async () => {
  const controller = new AbortController();
  const decoder = vi.fn<MediaCommandRunner>(() => new Promise(() => {}));
  const judge = vi.fn(async () => false);
  const task = deduplicateMedia(candidates, judge, { run: decoder, signal: controller.signal });
  const failed = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort();
  await failed;
  expect(decoder).toHaveBeenCalledTimes(1);
  expect(judge).not.toHaveBeenCalled();
});

it('passes cancellation to the pair cache and gates a late cache callback before model dispatch', async () => {
  const controller = new AbortController();
  const judge = vi.fn(async () => false);
  const pairCache = { compare: vi.fn(async (_left, _right, compare, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    return compare();
  }) };
  await expect(deduplicateMedia(candidates, judge, { run, pairCache, signal: controller.signal }))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(judge).not.toHaveBeenCalled();
  expect(pairCache.compare).toHaveBeenCalledTimes(1);
});
