import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type MediaCommandRunner = (
  command: 'ffmpeg' | 'ffprobe', args: readonly string[], input?: Buffer,
) => Promise<Buffer>;

export interface MediaCodecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Trusted process adapter for tests or sandboxed execution. */
  run?: MediaCommandRunner;
}

const tmpRoot = fileURLToPath(new URL('../../tmp/media-processing/', import.meta.url));
const activeTemps = new Set<string>();
const modelImageScale = "scale='min(2560,iw)':'min(2560,ih)':force_original_aspect_ratio=decrease:flags=lanczos";
// No playlists, concat, image2 filename sequences, or executable script demuxers.
const inputFormats = [
  'mov', 'matroska', 'avi', 'mpegts', 'mpeg', 'mpegvideo', 'm4v', 'h264', 'hevc', 'flv', 'asf', 'ogg',
  'image2pipe', 'png_pipe', 'jpeg_pipe', 'gif', 'gif_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe',
  'ppm_pipe', 'pgm_pipe', 'pbm_pipe', 'pam_pipe', 'jpegxl_pipe',
].join(',');

async function ensureTmpRoot(): Promise<void> {
  await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
  await chmod(tmpRoot, 0o700);
}

/** Remove this module's abandoned fallback directories older than 24 hours. */
export async function sweepComparisonTemps(now = Date.now()): Promise<void> {
  if (!Number.isFinite(now)) throw new RangeError('Invalid sweep time');
  await ensureTmpRoot();
  const entries = await readdir(tmpRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('comparison-')) continue;
    const path = join(tmpRoot, entry.name);
    if (activeTemps.has(path)) continue;
    try {
      if (now - (await stat(path)).mtimeMs > 86_400_000) await rm(path, { recursive: true, force: true });
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error;
    }
  }
}

function commandRunner(timeoutMs: number, maxOutputBytes: number): MediaCommandRunner {
  return (command, args, input) => new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let failure: Error | undefined;
    const stop = (message: string) => {
      failure ??= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop(`${command} timed out`), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxOutputBytes) stop(`${command} output exceeds limit`);
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    // A decoder may close stdin early after reading its first frame.
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(`${command} stdin: ${error.message}`);
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export function boundedOption(name: string, value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`Invalid ${name}`);
  return value;
}

export function createMediaRunner(options: MediaCodecOptions): MediaCommandRunner {
  const timeout = boundedOption('timeoutMs', options.timeoutMs ?? 30_000, 1, 2_147_483_647);
  const maxOutput = boundedOption('maxOutputBytes', options.maxOutputBytes ?? 32 * 1024 * 1024, 1, Infinity);
  const run = options.run ?? commandRunner(timeout, maxOutput);
  return (command, args, input) => run(command, [
    '-protocol_whitelist', 'pipe,file', '-format_whitelist', inputFormats, '-max_pixels', '40000000',
    ...(command === 'ffmpeg' ? ['-xerror'] : []), ...args,
  ], input);
}

export async function decodeImage(data: Buffer, run: MediaCommandRunner): Promise<Buffer> {
  const output = await run('ffmpeg', [
    '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1',
    '-vf', modelImageScale, '-pix_fmt', 'rgba',
    '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', 'pipe:1',
  ], data);
  if (!output.length) throw new Error('Media decoder produced no image');
  return output;
}

/** Decode the first image to PNG, fitting inside 2560 x 2560 without upscaling. */
export async function normalizeImage(data: Buffer, options: MediaCodecOptions = {}): Promise<Buffer> {
  if (!Buffer.isBuffer(data) || !data.length) throw new TypeError('Invalid image buffer');
  return decodeImage(data, createMediaRunner(options));
}

/** Model-only WebP at quality 90. Preserve text detail; never upscale or mutate the source. */
export async function compressModelImage(data: Buffer, options: MediaCodecOptions = {}): Promise<Buffer> {
  if (!Buffer.isBuffer(data) || !data.length) throw new TypeError('Invalid image buffer');
  const output = await createMediaRunner(options)('ffmpeg', [
    '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', 'pipe:0', '-map', '0:v:0', '-frames:v', '1',
    '-vf', modelImageScale, '-map_metadata', '-1', '-c:v', 'libwebp', '-threads', '1',
    '-quality', '90', '-preset', 'text', '-compression_level', '6', '-lossless', '0', '-f', 'webp', 'pipe:1',
  ], data);
  requireOutput(output);
  return output;
}

/** Some MP4 containers need a seekable input. Only that fallback writes to disk. */
export async function runVideo(
  run: MediaCommandRunner, command: 'ffmpeg' | 'ffprobe', data: Buffer,
  args: (input: string) => string[], validate: (output: Buffer) => void = requireOutput,
): Promise<Buffer> {
  try {
    const output = await run(command, args('pipe:0'), data);
    validate(output);
    return output;
  } catch {
    await ensureTmpRoot();
    const directory = await mkdtemp(join(tmpRoot, 'comparison-'));
    activeTemps.add(directory);
    try {
      const path = join(directory, 'input');
      await writeFile(path, data, { mode: 0o600 });
      const output = await run(command, args(path));
      validate(output);
      return output;
    } finally {
      try { await rm(directory, { recursive: true, force: true }); }
      finally { activeTemps.delete(directory); }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveDuration(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

function parseDuration(output: Buffer): number {
  const result: unknown = JSON.parse(output.toString());
  if (!isRecord(result)) throw new Error('ffprobe returned invalid metadata');
  const formatDuration = isRecord(result.format) ? positiveDuration(result.format.duration) : undefined;
  const streamDurations = Array.isArray(result.streams)
    ? result.streams.flatMap((stream: unknown) => {
      const duration = isRecord(stream) ? positiveDuration(stream.duration) : undefined;
      return duration === undefined ? [] : [duration];
    }) : [];
  const duration = formatDuration ?? (streamDurations.length ? Math.max(...streamDurations) : undefined);
  if (duration === undefined) throw new Error('Video has no usable duration');
  return duration;
}

function requireOutput(output: Buffer): void {
  if (!output.length) throw new Error('Media decoder produced no image');
}

export async function probeVideoDuration(data: Buffer, run: MediaCommandRunner): Promise<number> {
  const output = await runVideo(run, 'ffprobe', data, (input) => [
    '-v', 'error', '-show_entries', 'format=duration:stream=duration', '-of', 'json', input,
  ], (result) => { parseDuration(result); });
  return parseDuration(output);
}

export function extractVideoFrame(data: Buffer, time: number, run: MediaCommandRunner): Promise<Buffer> {
  return runVideo(run, 'ffmpeg', data, (input) => [
    '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', input,
    '-ss', String(time), '-map', '0:v:0', '-frames:v', '1',
    '-vf', modelImageScale, '-pix_fmt', 'rgba',
    '-f', 'image2pipe', '-c:v', 'png', '-threads', '1', 'pipe:1',
  ]);
}
