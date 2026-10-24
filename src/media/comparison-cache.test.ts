import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deduplicateMedia, type MediaCandidate, type MediaCommandRunner, type MediaJudge } from './comparison.js';
import { MediaPairCache } from './pair-cache.js';

const image = (text: string): MediaCandidate => ({ type: 'image', mimeType: 'image/png', data: Buffer.from(text) });
const framehash = (hash: string, dimensions = '32x32') =>
  Buffer.from(`#dimensions 0: ${dimensions}\n0, 0, 0, 1, 4096, ${hash.repeat(64)}\n`);
const runner = () => vi.fn<MediaCommandRunner>(async (_command, args, input) => {
  if (args.includes('framehash')) return framehash('a');
  if (args.includes('rawvideo')) return Buffer.alloc(1024, 120);
  return Buffer.from(`png:${input?.toString()}`);
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function cache() {
  await mkdir(resolve('tmp'), { recursive: true });
  const root = await mkdtemp(resolve('tmp/comparison-cache-test-')); roots.push(root);
  return new MediaPairCache('version', root);
}

it.each(['same', 'different'] as const)('reuses a reversed %s pair across posts before any codec work', async decision => {
  const pairCache = await cache();
  const run = runner();
  const judge = vi.fn<MediaJudge>(async () => decision);
  const items = [image('a'), image('b')];
  expect(await deduplicateMedia(items, judge, { run, pairCache })).toHaveLength(decision === 'same' ? 1 : 2);
  run.mockClear(); judge.mockClear();
  expect(await deduplicateMedia([...items].reverse(), judge, { run, pairCache })).toHaveLength(decision === 'same' ? 1 : 2);
  expect(run).not.toHaveBeenCalled();
  expect(judge).not.toHaveBeenCalled();
});

it('only judges new pairs when another source adds a unique image', async () => {
  const pairCache = await cache();
  const run = runner(); const judge = vi.fn<MediaJudge>(async () => 'different');
  const items = [image('a'), image('b')];
  await deduplicateMedia(items, judge, { run, pairCache });
  judge.mockClear();
  expect(await deduplicateMedia([...items, image('c')], judge, { run, pairCache })).toHaveLength(3);
  expect(judge).toHaveBeenCalledTimes(2);
});

it.each([true, false])('checks full-resolution RGBA before skipping vision, identical=%s', async identical => {
  const run = runner().mockImplementation(async (_command, args, input) => {
    if (args.includes('framehash')) {
      expect(args).not.toContain('scale=32:32,format=gray');
      expect(args).toContain('format=rgba');
      return framehash(identical || input?.toString() === 'a' ? 'a' : 'b');
    }
    if (args.includes('rawvideo')) return Buffer.alloc(1024);
    // Same scaled PNG can still hide different full-resolution color pixels.
    return Buffer.from('same-scaled-png');
  });
  const judge = vi.fn<MediaJudge>(async () => 'different');
  expect(await deduplicateMedia([image('a'), image('b')], judge, { run })).toHaveLength(identical ? 1 : 2);
  expect(judge).toHaveBeenCalledTimes(identical ? 0 : 1);
  expect(run.mock.calls.filter(([, args]) => args.includes('framehash'))).toHaveLength(2);
});

it('does not shortcut equal first frames of videos or animated images', async () => {
  const run = runner().mockImplementation(async (_command, args) => {
    if (args.includes('framehash')) return Buffer.concat([framehash('a'), Buffer.from(`0, 1, 1, 1, 4096, ${'b'.repeat(64)}\n`)]);
    if (args.includes('rawvideo')) return Buffer.alloc(1024);
    return Buffer.from('same-frame');
  });
  const judge = vi.fn<MediaJudge>(async () => 'different');
  const images = [image('a'), image('b')];
  expect(await deduplicateMedia(images, judge, { run })).toHaveLength(2);
  const videos = images.map(item => ({ ...item, type: 'video' as const, mimeType: 'video/mp4', duration: 10 }));
  expect(await deduplicateMedia(videos, judge, { run })).toHaveLength(2);
  expect(judge).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.filter(([, args]) => args.includes('framehash'))).toHaveLength(2);
});

it('requires matching full-image dimensions as well as matching RGBA hashes', async () => {
  const run = runner().mockImplementation(async (_command, args, input) => {
    if (args.includes('framehash')) return framehash('a', input?.toString() === 'a' ? '32x32' : '16x64');
    if (args.includes('rawvideo')) return Buffer.alloc(1024);
    return Buffer.from('same-scaled-png');
  });
  const judge = vi.fn<MediaJudge>(async () => 'different');
  expect(await deduplicateMedia([image('a'), image('b')], judge, { run })).toHaveLength(2);
  expect(judge).toHaveBeenCalledTimes(1);
});

const exec = promisify(execFile);
let hasFfmpeg = false;
try { await exec('ffmpeg', ['-version'], { timeout: 20_000 }); hasFfmpeg = true; } catch { /* Optional integration. */ }
describe.skipIf(!hasFfmpeg)('full decoded pixel integration', () => {
  it('deduplicates losslessly re-encoded equal RGB pixels without a model', async () => {
    const ppm = Buffer.concat([Buffer.from('P6\n16 16\n255\n'), Buffer.alloc(16 * 16 * 3, 123)]);
    const alternate = Buffer.concat([Buffer.from('P6\n# alternate encoding\n16 16\n255\n'), Buffer.alloc(16 * 16 * 3, 123)]);
    const first: MediaCandidate = { type: 'image', mimeType: 'image/x-portable-pixmap', data: ppm };
    const judge = vi.fn<MediaJudge>(async () => 'different');
    expect(await deduplicateMedia([first, { ...first, data: alternate }], judge)).toEqual([first]);
    expect(judge).not.toHaveBeenCalled();
  });
});
