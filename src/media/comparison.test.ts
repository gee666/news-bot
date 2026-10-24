import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  compressModelImage, deduplicateMedia, normalizeImage, sweepComparisonTemps,
  type MediaCandidate, type MediaCommandRunner, type MediaJudge,
} from './comparison.js';

const tmpRoot = fileURLToPath(new URL('../../tmp/media-processing/', import.meta.url));
const image = (text: string): MediaCandidate => ({ type: 'image', data: Buffer.from(text), mimeType: 'image/jpeg' });
const video = (text: string, duration?: number): MediaCandidate => ({
  type: 'video', data: Buffer.from(text), mimeType: 'video/mp4', ...(duration === undefined ? {} : { duration }),
});
const judge = () => vi.fn<MediaJudge>(async () => true);
const fakeRunner = () => vi.fn<MediaCommandRunner>(async (command, args, input) => {
  if (command === 'ffprobe') return Buffer.from('{"format":{"duration":"9"}}');
  if (args.includes('rawvideo')) return Buffer.alloc(1024, 120);
  return Buffer.from(`png:${input?.toString() ?? 'file'}`);
});

describe('deduplicateMedia', () => {
  it('keeps first exact size/duration/SHA matches without decoding or judging', async () => {
    const first = image('same');
    const movie = video('movie');
    const run = fakeRunner();
    const compare = judge();
    const result = await deduplicateMedia([first, image('same'), movie, video('movie')], compare, { run });
    expect(result).toEqual([first, movie]);
    expect(result[0]).toBe(first);
    expect(compare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('preserves the first-download deadline without refreshing it', async () => {
    const first = { ...image('same'), expiresAt: 1_700_000_000_000 };
    const second = { ...image('same'), expiresAt: 1_800_000_000_000 };
    expect(await deduplicateMedia([first, second], judge(), { run: fakeRunner() })).toEqual([first]);
    expect(first.expiresAt).toBe(1_700_000_000_000);
  });

  it('handles empty and singleton inputs and never compares across types', async () => {
    const compare = judge();
    const run = fakeRunner();
    const inputs = [image('bytes'), video('bytes', 12)];
    expect(await deduplicateMedia([], compare, { run })).toEqual([]);
    expect(await deduplicateMedia(inputs.slice(0, 1), compare, { run })).toEqual(inputs.slice(0, 1));
    expect(await deduplicateMedia(inputs, compare, { run })).toEqual(inputs);
    expect(run).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('does not treat size or duration equality as byte equality', async () => {
    const compare = judge().mockResolvedValue(false);
    const inputs = [image('aaaa'), image('bbbb'), image('longer')];
    expect(await deduplicateMedia(inputs, compare, { run: fakeRunner() })).toEqual(inputs);
    expect(compare).toHaveBeenCalledTimes(3);
  });

  it('keeps vastly different video durations without decoding or judging', async () => {
    const run = fakeRunner();
    const compare = judge();
    const inputs = [video('same', 10), video('same', 100)];
    expect(await deduplicateMedia(inputs, compare, { run })).toEqual(inputs);
    expect(run).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it('uses configurable absolute and relative duration tolerances, including the boundary', async () => {
    const inputs = [video('a', 10), video('b', 12)];
    const compare = judge();
    expect(await deduplicateMedia(inputs, compare, {
      run: fakeRunner(), durationToleranceSeconds: 2, durationToleranceRatio: 0,
    })).toEqual([inputs[0]]);
    compare.mockClear();
    expect(await deduplicateMedia(inputs, compare, {
      run: fakeRunner(), durationToleranceSeconds: 0, durationToleranceRatio: 0.1,
    })).toEqual(inputs);
    expect(compare).not.toHaveBeenCalled();
    expect(await deduplicateMedia(inputs, compare, {
      run: fakeRunner(), durationToleranceSeconds: 0, durationToleranceRatio: 0.2,
    })).toEqual([inputs[0]]);
  });

  it('probes missing durations, extracts one-third frames, and supplies typed metadata', async () => {
    const inputs = [video('a'), video('b', 10)];
    const run = fakeRunner();
    const compare = judge();
    expect(await deduplicateMedia(inputs, compare, { run })).toEqual([inputs[0]]);
    expect(run.mock.calls.filter(([command]) => command === 'ffprobe')).toHaveLength(1);
    const frames = run.mock.calls.filter(([, args]) => args.includes('-ss'));
    expect(frames.map(([, args]) => args[args.indexOf('-ss') + 1])).toEqual(['3', String(10 / 3)]);
    expect(compare).toHaveBeenCalledWith(Buffer.from('png:a'), Buffer.from('png:b'), {
      left: { type: 'video', mimeType: 'video/mp4', imageMimeType: 'image/png', size: 1, duration: 9, frameTime: 3 },
      right: { type: 'video', mimeType: 'video/mp4', imageMimeType: 'image/png', size: 1, duration: 10, frameTime: 10 / 3 },
      meanAbsoluteError: 0, hashDistance: 0,
    });
    expect(inputs[0]?.duration).toBeUndefined();
  });

  it('restricts protocols and demuxers on every ffprobe and ffmpeg input', async () => {
    const run = fakeRunner();
    await deduplicateMedia([video('a'), video('b', 10)], judge(), { run });
    for (const [, args] of run.mock.calls) {
      expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('pipe,file');
      expect(args[args.indexOf('-max_pixels') + 1]).toBe('40000000');
      const formats = args[args.indexOf('-format_whitelist') + 1]?.split(',');
      expect(formats).toContain('mov');
      expect(formats).toContain('png_pipe');
      for (const forbidden of ['hls', 'concat', 'image2', 'dash', 'avisynth', 'svg_pipe']) {
        expect(formats).not.toContain(forbidden);
      }
    }
  });

  it('accepts a stream duration when format duration is unavailable', async () => {
    const run = fakeRunner().mockImplementation(async (command, args) => {
      if (command === 'ffprobe') return Buffer.from('{"streams":[{"duration":"N/A"},{"duration":"10"}]}');
      return args.includes('rawvideo') ? Buffer.alloc(1024) : Buffer.from('png');
    });
    expect(await deduplicateMedia([video('a'), video('b', 10)], judge(), { run })).toHaveLength(1);
  });

  it('rejects unusable probe metadata rather than guessing a frame position', async () => {
    for (const metadata of ['null', '{}', '{"format":{"duration":"N/A"}}', 'invalid json']) {
      const run = fakeRunner().mockResolvedValue(Buffer.from(metadata));
      const compare = judge();
      await expect(deduplicateMedia([video('a'), video('b', 10)], compare, { run })).rejects.toThrow();
      expect(compare).not.toHaveBeenCalled();
    }
  });

  it('skips the judge only when both perceptual distinctness thresholds are met', async () => {
    const run = fakeRunner().mockImplementation(async (_command, args, input) => {
      if (!args.includes('rawvideo')) return input ?? Buffer.from('png');
      return Buffer.from(Array.from({ length: 1024 }, (_, i) => (i % 2 === 0) === (input?.toString() === 'a') ? 0 : 255));
    });
    const compare = judge();
    const inputs = [image('a'), image('b')];
    expect(await deduplicateMedia(inputs, compare, { run })).toEqual(inputs);
    expect(compare).not.toHaveBeenCalled();
    expect(await deduplicateMedia(inputs, compare, {
      run, distinctErrorThreshold: 1, distinctHashThreshold: 1,
    })).toEqual(inputs);
    const flatRun = fakeRunner().mockImplementation(async (_command, args, input) =>
      args.includes('rawvideo') ? Buffer.alloc(1024, input?.toString() === 'a' ? 0 : 255) : input ?? Buffer.from('png'));
    expect(await deduplicateMedia(inputs, compare, { run: flatRun })).toHaveLength(1);
    expect(compare).toHaveBeenCalledTimes(1);
  });

  it('sends equal grayscale thumbnails to the judge and reuses decoded images', async () => {
    const inputs = [image('a'), image('b'), image('c')];
    const compare = judge().mockResolvedValue(false);
    const run = fakeRunner();
    expect(await deduplicateMedia(inputs, compare, { run })).toEqual(inputs);
    expect(compare).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenCalledTimes(6);
    expect(compare.mock.calls[0]?.[2].left.imageMimeType).toBe('image/png');
  });

  it('propagates judge and decoder failures', async () => {
    await expect(deduplicateMedia([image('a'), image('b')], judge().mockRejectedValue(new Error('JEV failed')), {
      run: fakeRunner(),
    })).rejects.toThrow('JEV failed');
    const compare = judge();
    await expect(deduplicateMedia([image('a'), image('b')], compare, {
      run: fakeRunner().mockResolvedValue(Buffer.alloc(0)),
    })).rejects.toThrow('no image');
    await expect(deduplicateMedia([image('a'), image('b')], compare, {
      run: fakeRunner().mockImplementation(async (_command, args, input) =>
        args.includes('rawvideo') ? Buffer.from('bad thumbnail') : Buffer.from(`png:${input?.toString()}`)),
    })).rejects.toThrow('Invalid grayscale thumbnail');
    expect(compare).not.toHaveBeenCalled();
  });

  it('rejects invalid options and candidate metadata', async () => {
    for (const options of [{ durationToleranceSeconds: -1 }, { durationToleranceRatio: NaN },
      { distinctHashThreshold: 2 }, { timeoutMs: 0 }, { maxOutputBytes: Infinity }]) {
      await expect(deduplicateMedia([], judge(), options)).rejects.toThrow('Invalid');
    }
    for (const candidate of [video('a', NaN), video('a', 0), image(''), { ...image('a'), mimeType: 'video/mp4' }]) {
      await expect(deduplicateMedia([candidate], judge())).rejects.toThrow('Invalid media candidate');
    }
  });
});

describe('temporary file fallback', () => {
  it.each([false, true])('removes fallback files, including after failure=%s', async (fail) => {
    const paths: string[] = [];
    const run = fakeRunner().mockImplementation(async (command, args, input) => {
      if (command === 'ffprobe') {
        if (input) throw new Error('Requires seeking');
        const path = args.at(-1);
        if (!path) throw new Error('Missing path');
        paths.push(path);
        expect(path.startsWith(tmpRoot)).toBe(true);
        expect(await readFile(path, 'utf8')).toBe('a');
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700);
        expect((await stat(tmpRoot)).mode & 0o777).toBe(0o700);
        // A sweep must not remove this process's active fallback, even with an old mtime.
        const old = new Date(Date.now() - 172_800_000);
        await utimes(join(path, '..'), old, old);
        await sweepComparisonTemps();
        await access(path);
        if (fail) throw new Error('probe failed');
        return Buffer.from('{"format":{"duration":"100"}}');
      }
      throw new Error('Unexpected decoding');
    });
    const promise = deduplicateMedia([video('a'), video('b', 10)], judge(), { run });
    if (fail) await expect(promise).rejects.toThrow('probe failed');
    else expect(await promise).toHaveLength(2);
    expect(paths).toHaveLength(1);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  });

  it('retries seekable probing when stdin metadata lacks a duration', async () => {
    const paths: string[] = [];
    const run = fakeRunner().mockImplementation(async (_command, args, input) => {
      if (input) return Buffer.from('{"format":{"duration":"N/A"}}');
      const path = args.at(-1);
      if (!path) throw new Error('Missing path');
      paths.push(path);
      return Buffer.from('{"streams":[{"duration":"100"}]}');
    });
    expect(await deduplicateMedia([video('a'), video('b', 10)], judge(), { run })).toHaveLength(2);
    expect(paths).toHaveLength(1);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  });

  it.each([false, true])('cleans up seekable frame extraction after failure=%s', async (fail) => {
    const paths: string[] = [];
    const run = fakeRunner().mockImplementation(async (_command, args, input) => {
      if (!args.includes('-ss')) return Buffer.alloc(1024, 120);
      if (input) return Buffer.alloc(0);
      const path = args[args.indexOf('-i') + 1];
      if (!path) throw new Error('Missing path');
      paths.push(path);
      expect(path.startsWith(tmpRoot)).toBe(true);
      await access(path);
      if (fail) throw new Error('frame failed');
      return Buffer.from('frame');
    });
    const promise = deduplicateMedia([video('a', 10), video('b', 10)], judge(), { run });
    if (fail) await expect(promise).rejects.toThrow('frame failed');
    else expect(await promise).toHaveLength(1);
    expect(paths).toHaveLength(fail ? 1 : 2);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  });

  it('sweeps only old comparison directories, leaving recent and unrelated files alone', async () => {
    await mkdir(tmpRoot, { recursive: true });
    const old = await mkdtemp(join(tmpRoot, 'comparison-test-old-'));
    const recent = await mkdtemp(join(tmpRoot, 'comparison-test-recent-'));
    const unrelated = await mkdtemp(join(tmpRoot, 'unrelated-'));
    const now = Date.now();
    try {
      await writeFile(join(old, 'input'), 'leftover');
      await utimes(old, new Date(now - 172_800_000), new Date(now - 172_800_000));
      await utimes(unrelated, new Date(now - 172_800_000), new Date(now - 172_800_000));
      await sweepComparisonTemps(now);
      await expect(access(old)).rejects.toThrow();
      await access(recent);
      await access(unrelated);
    } finally {
      await Promise.all([old, recent, unrelated].map((path) => rm(path, { recursive: true, force: true })));
    }
  });
});

const exec = promisify(execFile);
const hasTools = await Promise.all(['ffmpeg', 'ffprobe'].map(async (command) => {
  try { await exec(command, ['-version'], { timeout: 20_000 }); return true; }
  catch { return false; }
}));

describe.skipIf(!hasTools.every(Boolean))('real ffmpeg integration', () => {
  it('normalizes an unsupported image format to a bounded PNG over stdin', async () => {
    const source = Buffer.concat([Buffer.from('P6\n3200 2\n255\n'), Buffer.alloc(3200 * 2 * 3, 100)]);
    const output = await normalizeImage(source);
    expect(output.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(output.readUInt32BE(16)).toBe(2560);
    expect(output.readUInt32BE(20)).toBeLessThanOrEqual(2560);
    await expect(normalizeImage(Buffer.alloc(0))).rejects.toThrow('Invalid image buffer');
    await expect(normalizeImage(Buffer.from('not an image'))).rejects.toThrow('ffmpeg');
  });

  it.each([{ name: 'image', normalize: normalizeImage }, { name: 'model image', normalize: compressModelImage }])(
    'rejects a disguised network playlist as $name without fetching its URL', async ({ normalize }) => {
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.end(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      const playlist = Buffer.from(`#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:${address.port}/segment.ts\n#EXT-X-ENDLIST\n`);
      await expect(normalize(playlist)).rejects.toThrow('ffmpeg');
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('enforces stdout and process time limits', async () => {
    const source = Buffer.concat([Buffer.from('P6\n64 64\n255\n'), Buffer.alloc(64 * 64 * 3, 100)]);
    await expect(normalizeImage(source, { maxOutputBytes: 8 })).rejects.toThrow('output exceeds limit');
    await expect(normalizeImage(source, { timeoutMs: 1 })).rejects.toThrow('timed out');
  });

  it('probes real MP4s and judges normalized one-third frames', async () => {
    const makeVideo = async (duration: number): Promise<MediaCandidate> => {
      const { stdout } = await exec('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', `color=red:s=32x32:r=10:d=${duration}`,
        '-threads', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
      ], { encoding: 'buffer', timeout: 5000, maxBuffer: 1024 * 1024 });
      return { type: 'video', mimeType: 'video/mp4', data: stdout };
    };
    await mkdir(tmpRoot, { recursive: true });
    const before = new Set(await readdir(tmpRoot));
    const inputs = await Promise.all([makeVideo(0.6), makeVideo(0.7)]);
    const compare = judge();
    expect(await deduplicateMedia(inputs, compare)).toEqual([inputs[0]]);
    const call = compare.mock.calls[0];
    expect(call?.[0].subarray(1, 4).toString()).toBe('PNG');
    expect(call?.[2].left.duration).toBeCloseTo(0.6);
    expect(call?.[2].left.frameTime).toBeCloseTo(0.2);
    expect(call?.[2].right.duration).toBeCloseTo(0.7);
    const leftovers = await readdir(tmpRoot);
    expect(leftovers.filter((name) => name.startsWith('comparison-') && !before.has(name))).toEqual([]);
  });
});
