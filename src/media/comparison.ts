import { createHash } from 'node:crypto';
import {
  boundedOption, createMediaRunner, decodeImage, extractVideoFrame, probeVideoDuration,
  type MediaCodecOptions, type MediaCommandRunner,
} from './codec.js';

export { compressModelImage, normalizeImage, sweepComparisonTemps } from './codec.js';
export type { MediaCodecOptions, MediaCommandRunner } from './codec.js';

export interface MediaCandidate {
  type: 'image' | 'video';
  data: Buffer;
  mimeType: string;
  /** Seconds. Missing video durations are obtained with ffprobe. */
  duration?: number;
  /** Absolute Unix-millisecond first-download deadline, never refreshed here. */
  expiresAt?: number;
}

export interface MediaImageMetadata {
  type: MediaCandidate['type'];
  mimeType: string;
  size: number;
  imageMimeType: 'image/png';
  duration?: number;
  frameTime?: number;
}

export interface MediaComparisonMetadata {
  left: MediaImageMetadata;
  right: MediaImageMetadata;
  /** Both metrics are in [0, 1]. Grayscale equality alone does not prove identity. */
  meanAbsoluteError: number;
  hashDistance: number;
}

/** Receives bounded PNG images. Return true only for duplicate media. */
export type MediaJudge = (
  left: Buffer, right: Buffer, metadata: MediaComparisonMetadata,
) => Promise<boolean>;

export interface MediaComparisonOptions extends MediaCodecOptions {
  /** Distinct when the duration gap exceeds max(seconds, ratio * longer duration). */
  durationToleranceSeconds?: number;
  durationToleranceRatio?: number;
  /** Both thresholds must be met before skipping the judge as clearly distinct. */
  distinctErrorThreshold?: number;
  distinctHashThreshold?: number;
}

interface Prepared {
  candidate: MediaCandidate;
  sha: string;
  duration?: number;
  image?: Buffer;
  thumbnail?: Buffer;
}

const thumbnailSide = 32;

async function getDuration(item: Prepared, run: MediaCommandRunner): Promise<number> {
  item.duration ??= await probeVideoDuration(item.candidate.data, run);
  return item.duration;
}

async function getImage(item: Prepared, run: MediaCommandRunner): Promise<Buffer> {
  if (!item.image) {
    item.image = item.candidate.type === 'image'
      ? await decodeImage(item.candidate.data, run)
      : await extractVideoFrame(item.candidate.data, await getDuration(item, run) / 3, run);
  }
  return item.image;
}

async function getThumbnail(item: Prepared, run: MediaCommandRunner): Promise<Buffer> {
  if (!item.thumbnail) {
    item.thumbnail = await run('ffmpeg', [
      '-v', 'error', '-threads', '1', '-filter_threads', '1', '-i', 'pipe:0',
      '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${thumbnailSide}:${thumbnailSide},format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], await getImage(item, run));
    if (item.thumbnail.length !== thumbnailSide ** 2) throw new Error('Invalid grayscale thumbnail');
  }
  return item.thumbnail;
}

function metrics(left: Buffer, right: Buffer): Pick<MediaComparisonMetadata, 'meanAbsoluteError' | 'hashDistance'> {
  let error = 0;
  let differentBits = 0;
  for (let y = 0; y < thumbnailSide; y++) {
    for (let x = 0; x < thumbnailSide; x++) {
      const i = y * thumbnailSide + x;
      const a = left.readUInt8(i);
      const b = right.readUInt8(i);
      error += Math.abs(a - b);
      if (x < thumbnailSide - 1 && (a > left.readUInt8(i + 1)) !== (b > right.readUInt8(i + 1))) differentBits++;
    }
  }
  return {
    meanAbsoluteError: error / (255 * thumbnailSide ** 2),
    hashDistance: differentBits / (thumbnailSide * (thumbnailSide - 1)),
  };
}

function metadata(item: Prepared): MediaImageMetadata {
  const { type, mimeType, data } = item.candidate;
  return {
    type, mimeType, size: data.length, imageMimeType: 'image/png',
    ...(item.duration === undefined ? {} : { duration: item.duration }),
    ...(type === 'video' && item.duration !== undefined ? { frameTime: item.duration / 3 } : {}),
  };
}

/**
 * Stable, first-wins deduplication within each media type. No inputs are mutated.
 * Exact size/duration/SHA matches bypass decoding. Lossy thumbnail matches go to
 * the judge because grayscale and downsampling discard color and small details.
 * Decoder and judge errors reject the operation, never silently discard media.
 */
export async function deduplicateMedia(
  candidates: readonly MediaCandidate[], judge: MediaJudge, options: MediaComparisonOptions = {},
): Promise<MediaCandidate[]> {
  const seconds = boundedOption('durationToleranceSeconds', options.durationToleranceSeconds ?? 2, 0, Infinity);
  const ratio = boundedOption('durationToleranceRatio', options.durationToleranceRatio ?? 0.1, 0, 1);
  const errorThreshold = boundedOption('distinctErrorThreshold', options.distinctErrorThreshold ?? 0.2, 0, 1);
  const hashThreshold = boundedOption('distinctHashThreshold', options.distinctHashThreshold ?? 0.35, 0, 1);
  const run = createMediaRunner(options);
  const prepared = candidates.map((candidate): Prepared => {
    if ((candidate.type !== 'image' && candidate.type !== 'video') || !Buffer.isBuffer(candidate.data)
      || candidate.data.length === 0 || typeof candidate.mimeType !== 'string'
      || !candidate.mimeType.startsWith(`${candidate.type}/`)
      || (candidate.duration !== undefined && (!Number.isFinite(candidate.duration) || candidate.duration <= 0))) {
      throw new TypeError('Invalid media candidate');
    }
    return {
      candidate, sha: createHash('sha256').update(candidate.data).digest('hex'),
      ...(candidate.duration === undefined ? {} : { duration: candidate.duration }),
    };
  });
  const kept: Prepared[] = [];
  for (const item of prepared) {
    let duplicate = false;
    for (const prior of kept) {
      if (prior.candidate.type !== item.candidate.type) continue;
      const sameBytes = prior.candidate.data.length === item.candidate.data.length && prior.sha === item.sha;
      if (sameBytes && (item.candidate.type === 'image' || prior.candidate.duration === item.candidate.duration)) {
        duplicate = true;
        break;
      }
      if (item.candidate.type === 'video') {
        const leftDuration = await getDuration(prior, run);
        const rightDuration = await getDuration(item, run);
        if (Math.abs(leftDuration - rightDuration) > Math.max(seconds, ratio * Math.max(leftDuration, rightDuration))) continue;
        if (sameBytes && leftDuration === rightDuration) { duplicate = true; break; }
      }
      const left = await getImage(prior, run);
      const right = await getImage(item, run);
      const comparison = metrics(await getThumbnail(prior, run), await getThumbnail(item, run));
      if (comparison.meanAbsoluteError >= errorThreshold && comparison.hashDistance >= hashThreshold) continue;
      const decision = await judge(left, right, { left: metadata(prior), right: metadata(item), ...comparison });
      if (typeof decision !== 'boolean') throw new TypeError('Media judge must return a boolean');
      if (decision) { duplicate = true; break; }
    }
    if (!duplicate) kept.push(item);
  }
  return kept.map(({ candidate }) => candidate);
}
