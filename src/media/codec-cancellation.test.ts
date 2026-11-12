import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { createMediaRunner } from './codec.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

it('kills the actual codec process on caller abort and cleans up its timer and listener', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; }),
  });
  mocks.spawn.mockReturnValue(child);
  const task = createMediaRunner({ signal: controller.signal })('ffmpeg', ['-i', 'pipe:0'], Buffer.from('image'));
  const failed = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  expect(mocks.spawn).toHaveBeenCalledOnce();
  controller.abort();
  await failed;
  await Promise.resolve();
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
});

it('does not spawn a process when its signal has already expired', () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => createMediaRunner({ signal: controller.signal })('ffprobe', [])).toThrow();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
