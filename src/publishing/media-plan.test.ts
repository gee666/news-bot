import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import { createHash } from 'node:crypto';
import { normalizeImage } from '../media/codec.js';
import { publicationMedia } from '../media/story-media.js';
import { deduplicateMedia, expirePublicationMedia, partitionMedia, preparePublicationMedia, recoverPublicationMedia } from './media-plan.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: mocks.transaction }));
vi.mock('../media/story-media.js', () => ({ publicationMedia: vi.fn() }));
vi.mock('../media/codec.js', () => ({ normalizeImage: vi.fn() }));
const publication: Publication = { id: 'publication', story_id: 'story', snapshot_id: 'snapshot', pending_snapshot_id: null,
  destination_id: '-100123', status: 'prepared', message_id: null, bot_id: '123', format_version: 1,
  attempt_count: 0, next_retry_at: null, created_at: new Date(), content: {} };

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.transaction.mockReset().mockImplementation(async (run: (client: Pick<PoolClient, 'query'>) => Promise<unknown>) => run({ query: mocks.query }));
  vi.mocked(publicationMedia).mockReset().mockResolvedValue([]);
  vi.mocked(normalizeImage).mockReset();
});

describe('temporary durable media plan', () => {
  it('deduplicates bytes before batching even when declarations differ', () => {
    expect(deduplicateMedia([
      { type: 'image', data: Buffer.from('same'), mimeType: 'image/jpeg' },
      { type: 'image', data: Buffer.from('same'), mimeType: 'image/png' },
      { type: 'video', data: Buffer.from('other'), mimeType: 'video/mp4' },
    ])).toMatchObject([{ type: 'image' }, { type: 'video' }]);
  });
  it('downloads first and persists deduplicated batches of at most ten', async () => {
    const items = Array.from({ length: 11 }, (_, index) => ({ type: 'image' as const, data: Buffer.from(String(index)), mimeType: 'image/jpeg' }));
    vi.mocked(publicationMedia).mockImplementation(async () => {
      expect(mocks.transaction).not.toHaveBeenCalled();
      return [...items, items[0]!];
    });
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT * FROM publications') ? [publication] : [] }));
    expect(await preparePublicationMedia(publication, defaultSettings)).toBe(true);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_batches'))).toHaveLength(1);
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_items'));
    expect(inserts).toHaveLength(10);
    expect(inserts.map(([, args]) => args[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(inserts.every(([, args]) => Buffer.isBuffer(args[5]))).toBe(true);
  });
  it('converts non-native images before freezing a new media-first plan, keeping native media and expiry intact', async () => {
    const expiresAt = Date.now() + 60_000;
    const source = { type: 'image' as const, mimeType: 'image/webp', data: Buffer.from('webp'), expiresAt };
    const png = Buffer.from('converted PNG');
    const video = { type: 'video' as const, mimeType: 'video/mp4', data: Buffer.from('mp4') };
    vi.mocked(publicationMedia).mockResolvedValue([source, source, video]);
    vi.mocked(normalizeImage).mockResolvedValue(png);
    const current = { ...publication, content: { presentationVersion: 1 } };
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT * FROM publications') ? [current] : [] }));
    await preparePublicationMedia(current, defaultSettings);
    expect(normalizeImage).toHaveBeenCalledExactlyOnceWith(source.data, { maxOutputBytes: 9_000_000 });
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_items'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[1].slice(2)).toEqual(['image', 'image/png', createHash('sha256').update(png).digest('hex'), png, expiresAt]);
    expect(inserts[1]?.[1][3]).toBe('video/mp4'); expect(inserts[1]?.[1][5]).toBe(video.data);
    expect(source.mimeType).toBe('image/webp'); expect(source.data.toString()).toBe('webp');
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_batches'))).toHaveLength(1);
  });
  it('does not persist a partial plan or fall back to documents when image conversion fails', async () => {
    vi.mocked(publicationMedia).mockResolvedValue([{ type: 'image', mimeType: 'image/webp', data: Buffer.from('invalid') }]);
    vi.mocked(normalizeImage).mockRejectedValue(new Error('decoder failed'));
    await expect(preparePublicationMedia({ ...publication, content: { presentationVersion: 1 } }, defaultSettings)).rejects.toThrow('decoder failed');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('uses the earliest duplicate deadline instead of resetting the cache TTL', () => {
    const deadline = Date.now() + 1000;
    expect(deduplicateMedia([
      { type: 'image', data: Buffer.from('same'), mimeType: 'image/jpeg' },
      { type: 'image', data: Buffer.from('same'), mimeType: 'image/jpeg', expiresAt: deadline },
    ])[0]?.expiresAt).toBe(deadline);
  });
  it('does not rebuild the committed plan for the same snapshot', async () => {
    expect(await preparePublicationMedia({ ...publication, media_snapshot_id: 'snapshot', media_status: 'pending' }, defaultSettings)).toBe(true);
    expect(publicationMedia).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(normalizeImage).not.toHaveBeenCalled();
  });
  it.each(['unknown','failed'] as const)('keeps a frozen %s plan without rebuilding or blocking canonical text', async media_status => {
    expect(await preparePublicationMedia({ ...publication,media_snapshot_id:'snapshot',media_status },defaultSettings)).toBe(true);
    expect(publicationMedia).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('does not dispatch or write a partial plan after a failed download', async () => {
    vi.mocked(publicationMedia).mockRejectedValue(new Error('download failed'));
    await expect(preparePublicationMedia(publication, defaultSettings)).rejects.toThrow('download failed');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it('quarantines interrupted requests rather than resetting them for retry', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ publication_id: 'publication' }] });
    await recoverPublicationMedia('-100123');
    expect(mocks.query.mock.calls[0]?.[0]).toContain("status='unknown'");
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('publication_media_requires_review'))).toBe(true);
    expect(mocks.query.mock.calls.every(([sql]) => !String(sql).includes("status='prepared'"))).toBe(true);
  });
  it('expires temporary bytes for every publication state while preserving unknown outcomes', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ batch_id: 'batch' }] });
    await expirePublicationMedia();
    expect(mocks.query.mock.calls[0]?.[0]).toContain('data=NULL');
    expect(mocks.query.mock.calls[0]?.[0]).toContain('expires_at<=now()');
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain('status');
    expect(mocks.query.mock.calls[1]?.[0]).toContain("status IN ('prepared','retryable')");
    expect(mocks.query.mock.calls[2]?.[0]).toContain("THEN 'unknown' ELSE 'failed'");
  });
});


describe('original-format plan partitioning', () => {
  it('splits the inherited picture and seven videos from post 2031 by total upload bytes', () => {
    const sizes = [795526, 9534417, 20533285, 6192958, 3535659, 22033699, 4001341, 17119076];
    const items = sizes.map((size, index) => ({ type: index === 0 ? 'image' as const : 'video' as const,
      mimeType: index === 0 ? 'image/png' : 'video/mp4', data: Buffer.alloc(size) }));
    const batches = partitionMedia(items);
    expect(batches.map(batch => batch.length)).toEqual([5, 3]);
    expect(batches.flat()).toEqual(items);
    expect(batches.every(batch => batch.reduce((bytes, item) => bytes + item.data.length, 0) <= 45_000_000)).toBe(true);
  });
  it('allows the exact byte boundary and starts a new batch for the next byte', () => {
    const items = [20_000_000, 25_000_000, 1].map(size => ({ type: 'video' as const,
      mimeType: 'video/mp4', data: Buffer.alloc(size) }));
    expect(partitionMedia(items).map(batch => batch.length)).toEqual([2, 1]);
    expect(() => partitionMedia([{ ...items[0]!, data: Buffer.alloc(45_000_001) }]))
      .toThrow('publication_media_too_large');
  });
  it('keeps contiguous document/native buckets in order and splits each at ten', () => {
    const native = Array.from({ length: 11 }, (_, index) => ({ type: 'image' as const, mimeType: 'image/png', data: Buffer.from(`png${index}`) }));
    const documents = [
      { type: 'video' as const, mimeType: 'video/webm', data: Buffer.from('original webm') },
      { type: 'video' as const, mimeType: 'video/quicktime', data: Buffer.from('original mov') },
      { type: 'image' as const, mimeType: 'image/gif', data: Buffer.from('original gif') },
    ];
    const mp4 = { type: 'video' as const, mimeType: 'video/mp4', data: Buffer.from('original mp4') };
    const input = [...native, ...documents, mp4];
    const batches = partitionMedia(input);
    expect(batches.map(batch => batch.length)).toEqual([10, 1, 3, 1]);
    expect(batches.flat()).toEqual(input);
    batches.flat().forEach((item, index) => expect(item.data).toBe(input[index]?.data));
  });
  it('persists document/native partitioning before dispatch without modifying bytes or MIME', async () => {
    const items = [
      { type: 'image' as const, mimeType: 'image/jpeg', data: Buffer.from('original jpg') },
      { type: 'video' as const, mimeType: 'video/webm', data: Buffer.from('original webm') },
      { type: 'video' as const, mimeType: 'video/quicktime', data: Buffer.from('original mov') },
      { type: 'video' as const, mimeType: 'video/mp4', data: Buffer.from('original mp4') },
    ];
    vi.mocked(publicationMedia).mockResolvedValue(items);
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT * FROM publications') ? [publication] : [] }));
    await preparePublicationMedia(publication, defaultSettings);
    const batches = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_batches'));
    expect(batches.map(([, args]) => args[2])).toEqual([0, 1, 2]);
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_items'));
    expect(inserts.map(([, args]) => args[1])).toEqual([0, 0, 1, 0]);
    inserts.forEach(([, args], index) => {
      expect(args[3]).toBe(items[index]?.mimeType);
      expect(args[5]).toBe(items[index]?.data);
    });
  });
});
