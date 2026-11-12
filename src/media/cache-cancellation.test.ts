import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MediaCache } from './cache.js';
import { MediaPairCache } from './pair-cache.js';

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename), rm: vi.fn(fs.rm) };
});
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const roots: string[] = [];
const candidate = { type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.from('image') };
function latch() {
  let open: () => void = () => {};
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
async function root() {
  await mkdir(resolve('tmp'), { recursive: true });
  const path = await mkdtemp(resolve('tmp/media-cancellation-test-'));
  roots.push(path);
  return path;
}
beforeEach(() => {
  vi.mocked(writeFile).mockReset().mockImplementation(fs.writeFile);
  vi.mocked(rename).mockReset().mockImplementation(fs.rename);
  vi.mocked(rm).mockReset().mockImplementation(fs.rm);
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

it('does not start a selection write with an expired signal', async () => {
  const cache = new MediaCache(await root());
  const controller = new AbortController();
  controller.abort();
  await expect(cache.save(randomUUID(), 'selection', [candidate], Date.now(), controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(writeFile).not.toHaveBeenCalled();
  expect(await readdir(cache.root)).toEqual([]);
});

it('serializes release after an in-flight aborted byte write so late work cannot recreate the directory', async () => {
  const cache = new MediaCache(await root());
  const id = randomUUID();
  const controller = new AbortController();
  const entered = latch(); const held = latch();
  vi.mocked(writeFile).mockImplementationOnce(async (path, data, options) => {
    entered.open();
    await held.promise;
    return fs.writeFile(path, data, options);
  });
  const save = cache.save(id, 'expired', [candidate], Date.now(), controller.signal);
  const failed = expect(save).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  controller.abort();
  const release = cache.release(id);
  await Promise.resolve();
  expect(rm).not.toHaveBeenCalled();
  held.open();
  await failed;
  await release;
  expect(await readdir(cache.root)).toEqual([]);
});

it('removes an aborted in-flight manifest before release and never deletes a later save', async () => {
  const cache = new MediaCache(await root());
  const id = randomUUID();
  const controller = new AbortController();
  const entered = latch(); const held = latch();
  vi.mocked(rename).mockImplementationOnce(async (source, target) => {
    await fs.rename(source, target);
    entered.open();
    await held.promise;
  });
  const save = cache.save(id, 'expired', [candidate], Date.now(), controller.signal);
  const failed = expect(save).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  controller.abort();
  const release = cache.release(id);
  const next = cache.save(id, 'fresh', [candidate]);
  held.open();
  await failed;
  await release;
  await next;
  expect(await cache.load(id, 'expired')).toBeNull();
  expect(await cache.load(id, 'fresh')).toEqual([expect.objectContaining(candidate)]);
  await cache.release(id);
  expect(await readdir(cache.root)).toEqual([]);
});

it('keeps a pair-cache write owned until an aborted rename unwinds, then permits a fresh verdict', async () => {
  const cache = new MediaPairCache('test', await root());
  const controller = new AbortController();
  const entered = latch(); const held = latch();
  vi.mocked(rename).mockImplementationOnce(async (source, target) => {
    await fs.rename(source, target);
    entered.open();
    await held.promise;
  });
  const task = cache.compare('a', 'b', async () => 'same', controller.signal);
  const failed = expect(task).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  controller.abort();
  await failed;
  const judge = vi.fn(async () => 'different' as const);
  const overlapping = cache.compare('a', 'b', judge);
  const overlapFailed = expect(overlapping).rejects.toMatchObject({ name: 'AbortError' });
  expect(judge).not.toHaveBeenCalled();
  held.open();
  await overlapFailed;
  expect(await readdir(cache.root)).toEqual([]);
  expect(await cache.compare('a', 'b', judge)).toBe('different');
  expect(await cache.compare('b', 'a', judge)).toBe('different');
  expect(judge).toHaveBeenCalledTimes(1);
  expect((await readdir(cache.root)).every(name => name.endsWith('.json'))).toBe(true);
});
