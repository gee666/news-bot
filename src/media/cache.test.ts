import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MediaCache, MEDIA_TTL_MS } from './cache.js';

const roots: string[] = [];
async function setup() {
  await mkdir(resolve('tmp'), { recursive: true });
  const root = await mkdtemp(resolve('tmp/media-cache-test-')); roots.push(root);
  return new MediaCache(root);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const candidate = { type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.from('test image') };

it('round trips only temporary media and invalidates changed source fingerprints', async () => {
  const cache = await setup(); const id = randomUUID();
  await cache.save(id, 'source-v1', [candidate], 100);
  expect(await cache.load(id, 'source-v1', 200)).toEqual([expect.objectContaining(candidate)]);
  expect(await cache.load(id, 'source-v2', 200)).toBeNull();
  await cache.release(id);
  expect(await readdir(cache.root)).toEqual([]);
});

it('expires never-published media at one week and does not extend expiry on updates', async () => {
  const cache = await setup(); const id = randomUUID();
  await cache.save(id, 'v1', [candidate], 100);
  await cache.save(id, 'v2', [candidate], MEDIA_TTL_MS);
  expect(await cache.load(id, 'v2', MEDIA_TTL_MS + 99)).toEqual([expect.objectContaining(candidate)]);
  await cache.sweep(MEDIA_TTL_MS + 100);
  expect(await readdir(cache.root)).toEqual([]);
});

it('shares no files across stories and removes discarded candidates', async () => {
  const cache = await setup(); const first = randomUUID(); const second = randomUUID();
  await cache.save(first, 'v1', [candidate]); await cache.save(second, 'v1', [candidate]);
  await cache.release(first);
  expect(await cache.load(second, 'v1')).toEqual([expect.objectContaining(candidate)]);
  await cache.save(second, 'v2', []);
  expect(await readdir(join(cache.root, second))).toEqual(['manifest.json']);
});

it('rejects path traversal identifiers', async () => {
  const cache = await setup();
  await expect(cache.release('../outside')).rejects.toThrow();
});


it('keeps provisional attachments without treating unresolved comparisons as a final selection or extending TTL', async () => {
  const cache = await setup(); const id = randomUUID();
  await cache.save(id, 'unresolved:selection', [candidate], 100);
  expect(await cache.load(id, 'selection', 200)).toBeNull();
  const expiresAt = await cache.save(id, 'selection', [candidate], 300);
  expect(expiresAt).toBe(100 + MEDIA_TTL_MS);
  expect(await cache.load(id, 'selection', 400)).toEqual([expect.objectContaining(candidate)]);
});
