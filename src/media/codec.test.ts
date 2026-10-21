import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createMediaRunner, extractVideoFrame } from './codec.js';
import { compressModelImage, normalizeImage, type MediaCommandRunner } from './comparison.js';

const exec = promisify(execFile);
const ppm = (width: number, height: number, pixels = Buffer.alloc(width * height * 3, 100)) =>
  Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);

describe('compressModelImage', () => {
  it('uses quality 90, the text preset, Lanczos, and secure input limits without modifying the source', async () => {
    const source = Buffer.from('original');
    const run = vi.fn<MediaCommandRunner>(async () => Buffer.from('webp'));
    expect(await compressModelImage(source, { run })).toEqual(Buffer.from('webp'));
    const args = run.mock.calls[0]?.[1] ?? [];
    for (const [option, value] of [
      ['-protocol_whitelist', 'pipe,file'], ['-max_pixels', '40000000'], ['-i', 'pipe:0'],
      ['-c:v', 'libwebp'], ['-quality', '90'], ['-preset', 'text'], ['-compression_level', '6'],
      ['-lossless', '0'], ['-frames:v', '1'], ['-f', 'webp'], ['-threads', '1'],
    ]) expect(args[args.indexOf(option ?? '') + 1]).toBe(value);
    expect(args.indexOf('-max_pixels')).toBeLessThan(args.indexOf('-i'));
    expect(args).toContain('-xerror');
    expect(args).toContain('-format_whitelist');
    expect(args[args.indexOf('-vf') + 1]).toBe(
      "scale='min(2560,iw)':'min(2560,ih)':force_original_aspect_ratio=decrease:flags=lanczos",
    );
    expect(args.at(-1)).toBe('pipe:1');
    expect(run.mock.calls[0]?.[2]).toBe(source);
    expect(source.toString()).toBe('original');
  });

  it('keeps comparison images and video frames at the same 2560-pixel bound', async () => {
    const run = vi.fn<MediaCommandRunner>(async () => Buffer.from('png'));
    await normalizeImage(Buffer.from('image'), { run });
    await extractVideoFrame(Buffer.from('video'), 3, createMediaRunner({ run }));
    expect(run).toHaveBeenCalledTimes(2);
    for (const [, args] of run.mock.calls) {
      expect(args[args.indexOf('-vf') + 1]).toContain("min(2560,iw)");
      expect(args[args.indexOf('-vf') + 1]).toContain("min(2560,ih)");
      expect(args[args.indexOf('-c:v') + 1]).toBe('png');
    }
  });

  it('rejects empty data, invalid limits, empty output, and decoder failures', async () => {
    await expect(compressModelImage(Buffer.alloc(0))).rejects.toThrow('Invalid image buffer');
    await expect(compressModelImage(Buffer.from('image'), { timeoutMs: 0 })).rejects.toThrow('Invalid timeoutMs');
    await expect(compressModelImage(Buffer.from('image'), { maxOutputBytes: -1 })).rejects.toThrow('Invalid maxOutputBytes');
    await expect(compressModelImage(Buffer.from('image'), {
      run: async () => Buffer.alloc(0),
    })).rejects.toThrow('no image');
    await expect(compressModelImage(Buffer.from('image'), {
      run: async () => { throw new Error('decoder failed'); },
    })).rejects.toThrow('decoder failed');
  });
});

const hasTools = await Promise.all(['ffmpeg', 'ffprobe'].map(async (command) => {
  try { await exec(command, ['-version'], { timeout: 20_000 }); return true; }
  catch { return false; }
}));

describe.skipIf(!hasTools.every(Boolean))('real model image compression', () => {
  it.each([
    { width: 3200, height: 1600, expectedWidth: 2560, expectedHeight: 1280 },
    { width: 320, height: 3200, expectedWidth: 256, expectedHeight: 2560 },
    { width: 100, height: 40, expectedWidth: 100, expectedHeight: 40 },
  ])('encodes WebP at $expectedWidth x $expectedHeight from $width x $height', async (dimensions) => {
    const { width, height, expectedWidth, expectedHeight } = dimensions;
    const source = ppm(width, height);
    const original = Buffer.from(source);
    const output = await compressModelImage(source);
    expect(output.subarray(0, 4).toString()).toBe('RIFF');
    expect(output.subarray(8, 12).toString()).toBe('WEBP');
    const metadata = await createMediaRunner({})('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', 'pipe:0',
    ], output);
    const parsed: unknown = JSON.parse(metadata.toString());
    expect(parsed).toMatchObject({ streams: [{ codec_name: 'webp', width: expectedWidth, height: expectedHeight }] });
    expect(source.equals(original)).toBe(true);
    expect(output.length).toBeLessThan(source.length);
  });

  it('preserves thin text strokes and high contrast through real WebP decoding', async () => {
    const width = 96;
    const height = 24;
    const pixels = Buffer.alloc(width * height * 3, 255);
    const expected = Buffer.alloc(width * height, 255);
    const glyphs = [
      ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
      ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
      ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
      ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    ];
    glyphs.forEach((rows, letter) => rows.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit !== '1') return;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const index = (4 + y * 2 + dy) * width + 4 + letter * 12 + x * 2 + dx;
        pixels.fill(0, index * 3, index * 3 + 3);
        expected.writeUInt8(0, index);
      }
    })));
    const output = await compressModelImage(ppm(width, height, pixels));
    const decoded = await createMediaRunner({})('ffmpeg', [
      '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', 'pipe:0', '-frames:v', '1',
      '-vf', 'format=gray', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
    ], output);
    expect(decoded.length).toBe(expected.length);
    const error = expected.reduce((sum, value, index) => sum + Math.abs(value - decoded.readUInt8(index)), 0);
    expect(error / expected.length).toBeLessThan(4);
    expect(decoded.readUInt8(4 * width + 4)).toBeLessThan(32);
    expect(decoded.readUInt8(0)).toBeGreaterThan(240);
  });

  it('extracts a full-detail 2560-pixel video frame before model compression', async () => {
    const { stdout } = await exec('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=blue:s=3200x32:r=10:d=0.2',
      '-threads', '1', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
    ], { encoding: 'buffer', timeout: 10_000, maxBuffer: 1024 * 1024 });
    const frame = await extractVideoFrame(stdout, 0, createMediaRunner({}));
    expect(frame.subarray(1, 4).toString()).toBe('PNG');
    expect(frame.readUInt32BE(16)).toBe(2560);
    const output = await compressModelImage(frame);
    expect(output.subarray(8, 12).toString()).toBe('WEBP');
  });

  it('enforces decoder pixel, stdout, and process time limits', async () => {
    await expect(compressModelImage(Buffer.from('P6\n6400 6400\n255\n0'))).rejects.toThrow(/max.*pixel|pixel.*count/i);
    await expect(compressModelImage(ppm(64, 64), { maxOutputBytes: 8 })).rejects.toThrow('output exceeds limit');
    await expect(compressModelImage(ppm(64, 64), { timeoutMs: 1 })).rejects.toThrow('timed out');
    await expect(compressModelImage(Buffer.from('not an image'))).rejects.toThrow('ffmpeg');
  });
});
