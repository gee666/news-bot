import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MediaPairCache, type MediaVerdict } from './pair-cache.js';
import { MEDIA_TTL_MS } from './cache.js';
import { mediaJudgmentVersion } from './judgment.js';
import { defaultSettings } from '../settings.js';

const roots: string[] = [];
async function setup(version = 'model-prompt-v1', root?: string) {
  await mkdir(resolve('tmp'), { recursive: true });
  root ??= await mkdtemp(resolve('tmp/media-pairs-test-'));
  roots.push(root);
  return new MediaPairCache(version, root);
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(['same', 'different'] as const)('persists symmetric %s verdicts across cache instances', async decision => {
  const cache = await setup();
  const judge = vi.fn(async () => decision);
  expect(await cache.compare('hash-a', 'hash-b', judge)).toBe(decision);
  const restarted = new MediaPairCache(cache.version, cache.root);
  expect(await restarted.compare('hash-b', 'hash-a', judge)).toBe(decision);
  expect(judge).toHaveBeenCalledTimes(1);
  const files = await readdir(cache.root);
  expect(files).toHaveLength(1);
  const file = join(cache.root, files[0] ?? 'missing');
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ decision, expiresAt: expect.any(Number) });
});

it.each(['unresolved', false, true] as const)('does not persist ambiguous or legacy %s results', async decision => {
  const cache = await setup();
  const judge = vi.fn<() => Promise<MediaVerdict>>(async () => decision);
  await cache.compare('a', 'b', judge);
  await cache.compare('b', 'a', judge);
  expect(judge).toHaveBeenCalledTimes(2);
  expect(await readdir(cache.root)).toEqual([]);
});

it('retries failures and coalesces concurrent reversed comparisons', async () => {
  const cache = await setup();
  const judge = vi.fn<() => Promise<MediaVerdict>>().mockRejectedValueOnce(new Error('outage')).mockResolvedValue('same');
  await expect(cache.compare('a', 'b', judge)).rejects.toThrow('outage');
  expect(await Promise.all([cache.compare('a', 'b', judge), cache.compare('b', 'a', judge)])).toEqual(['same', 'same']);
  expect(judge).toHaveBeenCalledTimes(2);
});

it('expires without refreshing on reads, sweeps old results and separates versions', async () => {
  vi.useFakeTimers(); vi.setSystemTime(1_700_000_000_000);
  const cache = await setup();
  const judge = vi.fn<() => Promise<MediaVerdict>>(async () => 'different');
  await cache.compare('a', 'b', judge);
  vi.setSystemTime(Date.now() + MEDIA_TTL_MS - 1);
  await cache.compare('b', 'a', judge);
  expect(judge).toHaveBeenCalledTimes(1);
  await new MediaPairCache('changed-prompt', cache.root).compare('a', 'b', judge);
  expect(judge).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 1);
  await cache.sweep();
  expect(await readdir(cache.root)).toHaveLength(1);
  await cache.compare('a', 'b', judge);
  expect(judge).toHaveBeenCalledTimes(3);
});

it('versions vision provider/model, JEV endpoint/model, and model revision', () => {
  const baseline = mediaJudgmentVersion(defaultSettings);
  for (const change of [{ piProvider: 'openai' }, { piModel: 'another' }, { jevUrl: 'http://another:8765' },
    { jevModel: 'another' }, { modelVersion: defaultSettings.modelVersion + 1 }]) {
    // Test a provider distinct from the configured default too.
    const settings = { ...defaultSettings, ...change };
    if (JSON.stringify(settings) !== JSON.stringify(defaultSettings)) expect(mediaJudgmentVersion(settings)).not.toBe(baseline);
  }
});
