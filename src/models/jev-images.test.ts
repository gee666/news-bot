import { expect, it } from 'vitest';
import { jevImagePayload } from './jev-images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const webp = Buffer.from('UklGRnAAAABXRUJQVlA4IGQAAAAQBwCdASqAAIAAPjEYi0SiIaEQRAAgAwS0t3C6TLgPwA/AAAC1YSrOcgjYgqOe2IvEFRz2xF4gqOe2IvEFRz2wuAD+/zwb//+xmP2jP8kr//+DMfwZj+DMf/CfGxI0QAAAAAAA', 'base64');
function image(bytes = png, mimeType = 'image/png') { return { data: bytes.toString('base64'), mimeType }; }

it('emits ordered top-level data URLs and leaves text-only requests empty', () => {
  expect(jevImagePayload()).toEqual([]);
  expect(jevImagePayload([image(), image(webp, 'image/webp')])).toEqual([
    `data:image/png;base64,${png.toString('base64')}`, `data:image/webp;base64,${webp.toString('base64')}`,
  ]);
  expect(jevImagePayload(Array.from({ length: 4 }, () => image()))).toHaveLength(4);
});

it.each([
  [image(Buffer.from('private-invalid-image'))],
  [{ data: 'bad base64', mimeType: 'image/png' }],
  [{ data: 'data:image/png;base64,' + png.toString('base64'), mimeType: 'image/png' }],
  [{ data: 'AB==', mimeType: 'image/png' }],
  [image(png, 'image/gif')],
  [image(png, 'image/jpeg')],
  Array.from({ length: 5 }, () => image()),
  [image(Buffer.alloc(8_000_001))],
].map(images => ({ images })))('rejects unsupported, malformed, mismatched or oversized attachments', ({ images }) => {
  expect(() => jevImagePayload(images)).toThrow(expect.objectContaining({ kind: 'invalid_request', detail: { outcome: 'not_submitted' } }));
});

it('rejects zero or more than 16 million pixels from encoded dimensions', () => {
  const exact = Buffer.from(png); exact.writeUInt32BE(4000, 16); exact.writeUInt32BE(4000, 20);
  expect(jevImagePayload([image(exact)])).toHaveLength(1);
  const over = Buffer.from(exact); over.writeUInt32BE(4001, 16);
  expect(() => jevImagePayload([image(over)])).toThrow();
  const zero = Buffer.from(png); zero.writeUInt32BE(0, 16);
  expect(() => jevImagePayload([image(zero)])).toThrow();
});

it('reads JPEG frame dimensions after metadata and refuses truncated marker segments', () => {
  // Header-only fixtures exercise transport dimension checks, not full provider decoding.
  const jpeg = Buffer.from('ffd8ffe000040000ffc00008080001000201ffd9', 'hex');
  expect(jevImagePayload([image(jpeg, 'image/jpeg')])).toHaveLength(1);
  const large = Buffer.from(jpeg); large.writeUInt16BE(65535, 13); large.writeUInt16BE(65535, 15);
  expect(() => jevImagePayload([image(large, 'image/jpeg')])).toThrow();
  expect(() => jevImagePayload([image(jpeg.subarray(0, 15), 'image/jpeg')])).toThrow();
});

it.each(['VP8X', 'VP8L'])('reads %s WebP canvas bounds', kind => {
  const data = Buffer.alloc(kind === 'VP8X' ? 30 : 26);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WEBP', 8); data.write(kind, 12);
  data.writeUInt32LE(kind === 'VP8X' ? 10 : 5, 16);
  if (kind === 'VP8L') data[20] = 0x2f;
  expect(jevImagePayload([image(data, 'image/webp')])).toHaveLength(1);
  if (kind === 'VP8X') { data.writeUIntLE(16383, 24, 3); data.writeUIntLE(16383, 27, 3); }
  else data.writeUInt32LE(0x0fffffff, 21);
  expect(() => jevImagePayload([image(data, 'image/webp')])).toThrow();
});

it('uses the documented decimal byte limit, not an 8 MiB limit', () => {
  const exact = Buffer.alloc(8_000_000); png.copy(exact);
  expect(jevImagePayload([image(exact)])).toHaveLength(1);
  const over = Buffer.alloc(8_000_001); png.copy(over);
  expect(() => jevImagePayload([image(over)])).toThrow(expect.objectContaining({ kind: 'invalid_request' }));
});
