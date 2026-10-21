import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import { publicationMedia } from '../media/story-media.js';
import { deduplicateMedia, expirePublicationMedia, partitionMedia, preparePublicationMedia, recoverPublicationMedia } from './media-plan.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../db.js', () => ({ transaction: mocks.transaction }));
vi.mock('../media/story-media.js', () => ({ publicationMedia: vi.fn() }));
const publication: Publication = { id: 'publication', story_id: 'story', snapshot_id: 'snapshot', pending_snapshot_id: null,
  destination_id: '-100123', status: 'prepared', message_id: null, bot_id: '123', format_version: 1,
  attempt_count: 0, next_retry_at: null, created_at: new Date(), content: {} };

beforeEach(() => {
  mocks.query.mockReset().mockResolvedValue({ rows: [] });
  mocks.transaction.mockReset().mockImplementation(async (run: (client: Pick<PoolClient, 'query'>) => Promise<unknown>) => run({ query: mocks.query }));
  vi.mocked(publicationMedia).mockReset().mockResolvedValue([]);
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
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_batches'))).toHaveLength(2);
    const inserts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_media_items'));
    expect(inserts).toHaveLength(11);
    expect(inserts.map(([, args]) => args[1])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0]);
    expect(inserts.every(([, args]) => Buffer.isBuffer(args[5]))).toBe(true);
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
    expect(mocks.query.mock.calls[1]?.[0]).toContain('publication_media_requires_review');
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
      { type: 'image' as const, mimeType: 'image/webp', data: Buffer.from('original webp') },
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
