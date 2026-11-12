import { afterEach, expect, it, vi } from 'vitest';
import { abortable, MediaDeadline, mediaDeadlineMs } from './deadline.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

it('defaults the overall budget to two minutes and validates configuration', () => {
  vi.stubEnv('MEDIA_PREPARATION_TIMEOUT_MS', undefined);
  expect(mediaDeadlineMs()).toBe(120_000);
  vi.stubEnv('MEDIA_PREPARATION_TIMEOUT_MS', '500');
  expect(mediaDeadlineMs()).toBe(500);
  for (const value of ['0', '-1', 'no', '1.2', '2147483648']) {
    vi.stubEnv('MEDIA_PREPARATION_TIMEOUT_MS', value);
    expect(mediaDeadlineMs).toThrow('MEDIA_PREPARATION_TIMEOUT_MS');
  }
});

it('aborts an uncooperative step, consumes its late rejection, and clears its timer', async () => {
  vi.useFakeTimers();
  const deadline = new MediaDeadline(50);
  let fail: (error: Error) => void = () => {};
  const task = deadline.run(() => new Promise((_, reject) => { fail = reject; }));
  const rejected = expect(task).rejects.toMatchObject({ name: 'TimeoutError' });
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  fail(new Error('late failure'));
  await Promise.resolve();
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not start work after cancellation, even when an adapter resolves during abort', async () => {
  const controller = new AbortController();
  const work = vi.fn(async () => {
    controller.abort();
    return 1;
  });
  await expect(abortable(controller.signal, work)).rejects.toMatchObject({ name: 'AbortError' });
  expect(() => abortable(controller.signal, work)).toThrow();
  expect(work).toHaveBeenCalledTimes(1);
});

it('disposes successful deadlines without a lingering timer', async () => {
  vi.useFakeTimers();
  const deadline = new MediaDeadline(100);
  expect(await deadline.run(async () => 7)).toBe(7);
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
