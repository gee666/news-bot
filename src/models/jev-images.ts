import { z } from 'zod';
import { RequestFault } from './errors.js';
import type { ModelImage } from './images.js';

const maxBytes = 8_000_000;
const maxPixels = 16_000_000;
const imageSchema = z.object({ data: z.string().min(1).max(4 * Math.ceil(maxBytes / 3)),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']) });

function invalid(): never { throw new RequestFault('invalid_request', { outcome: 'not_submitted' }); }

/** Validate transport bounds and encoded dimensions. The provider still validates full image decoding. */
export function jevImagePayload(images: readonly ModelImage[] = []): string[] {
  const parsed = z.array(imageSchema).max(4).safeParse(images);
  if (!parsed.success) return invalid();
  return parsed.data.map(image => {
    const bytes = Buffer.from(image.data, 'base64');
    if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64') !== image.data) return invalid();
    const [width, height] = dimensions(bytes, image.mimeType);
    if (width <= 0 || height <= 0 || width * height > maxPixels) return invalid();
    return `data:${image.mimeType};base64,${image.data}`;
  });
}

function dimensions(bytes: Buffer, mime: string): readonly [number, number] {
  if (mime === 'image/png') {
    if (bytes.length < 33 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return invalid();
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) return invalid();
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + size % 2 > bytes.length) return invalid();
    if (kind === 'VP8X' && size === 10) return [bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1];
    if (kind === 'VP8 ' && size >= 10 && bytes.subarray(start + 3, start + 6).toString('hex') === '9d012a') {
      return [bytes.readUInt16LE(start + 6) & 0x3fff, bytes.readUInt16LE(start + 8) & 0x3fff];
    }
    if (kind === 'VP8L' && size >= 5 && bytes[start] === 0x2f) {
      const bits = bytes.readUInt32LE(start + 1);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
    offset = start + size + size % 2;
  }
  return invalid();
}

function jpegDimensions(bytes: Buffer): readonly [number, number] {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return invalid();
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return invalid();
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return invalid();
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return invalid();
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (size < 8) return invalid();
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += size;
  }
  return invalid();
}
