import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import { releaseStoryMedia } from '../media/story-media.js';
import { BotApi, BotError } from './bot-api.js';
import { deletePublicationMedia, deliverPublicationMedia, retryPublicationMedia } from './media-delivery.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), rateLimited: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: mocks.transaction }));
vi.mock('../settings.js', async original => {
  const settings = await original<typeof import('../settings.js')>();
  return { ...settings, getSettings: async () => ({ ...settings.defaultSettings, publishingEnabled: true }) };
});
vi.mock('./store.js', () => ({ destination: async () => '-100123', rateLimited: mocks.rateLimited, publicationSelect: 'SELECT p.* FROM publications p' }));
vi.mock('../media/story-media.js', () => ({ releaseStoryMedia: vi.fn().mockResolvedValue(undefined) }));
const enabled = { ...defaultSettings, publishingEnabled: true };
const publication: Publication = { id: 'publication', story_id: 'story', snapshot_id: 'snapshot', pending_snapshot_id: null,
  destination_id: '-100123', status: 'published', message_id: '9', bot_id: '123', format_version: 1,
  attempt_count: 0, next_retry_at: null, created_at: new Date(), content: {}, media_status: 'pending', media_snapshot_id: 'snapshot' };
const item = { id: 'item', type: 'image', mime_type: 'image/jpeg', data: Buffer.from('bytes'), message_id: null, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) };
let api: BotApi;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
  api = new BotApi('123:synthetic');
  mocks.rateLimited.mockReset().mockResolvedValue(false);
  mocks.transaction.mockReset().mockImplementation(async (run: (client: Pick<PoolClient, 'query'>) => Promise<unknown>) => run({ query: mocks.query }));
  mocks.query.mockReset().mockImplementation(async (sql: string) => ({ rows:
    sql.includes('SELECT * FROM publication_media_batches') ? [{ id: 'batch', status: 'prepared', attempt_count: 0, next_retry_at: null }]
      : sql.includes('SELECT * FROM publication_media_items') ? [item]
        : sql.includes('SELECT * FROM publications p') ? [publication]
          : sql.includes('RETURNING id') ? [{ id: 'batch' }]
            : sql.includes('RETURNING true AS complete') ? [{ complete: true }] : [] }));
  vi.mocked(releaseStoryMedia).mockClear();
});

describe('durable attachment delivery', () => {
  it('commits the running request before upload, saves ids and deletes bytes immediately after success', async () => {
    const send = vi.spyOn(api, 'sendMedia').mockImplementation(async () => {
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET status='running'"))).toBe(true);
      return ['10'];
    });
    expect(await deliverPublicationMedia(publication, api, enabled)).toBe(true);
    expect(send).toHaveBeenCalledWith('-100123', '9', [{ type: 'image', data: item.data, mimeType: 'image/jpeg' }]);
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('message_id=$2,data=NULL'))?.[1]).toEqual(['item', '10']);
    expect(releaseStoryMedia).toHaveBeenCalledWith('story');
  });
  it.each([
    ['unknown', 'unknown', null, 'publication_media_requires_review'],
    ['failed', 'failed', null, 'publication_media_failed'],
    ['retryable', 'pending', expect.any(Date), 'publication_media_retryable'],
  ] as const)('keeps %s outcomes distinct', async (outcome, state, retry, errorCode) => {
    vi.spyOn(api, 'sendMedia').mockRejectedValue(new BotError('safe_error', outcome, 120_000));
    expect(await deliverPublicationMedia(publication, api, enabled)).toBe(false);
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('SET status=$2'))?.[1])
      .toEqual(['batch', outcome, 'safe_error', retry]);
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('media_status=$2'))?.[1])
      .toEqual(['publication', state, errorCode]);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('data=NULL'))).toBe(false);
    expect(releaseStoryMedia).not.toHaveBeenCalled();
  });
  it('never sends an interrupted, ambiguous or permanently rejected batch again', async () => {
    const send = vi.spyOn(api, 'sendMedia');
    for (const status of ['running', 'unknown', 'failed']) {
      mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: 'batch', status }] });
      expect(await deliverPublicationMedia(publication, api, enabled)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
  });
  it('does not resend earlier successful batches and honors the saved rate limit', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
      { id: 'batch1', status: 'sent' },
      { id: 'batch2', status: 'retryable', next_retry_at: new Date(Date.now() + 120_000) },
    ] });
    const send = vi.spyOn(api, 'sendMedia');
    expect(await deliverPublicationMedia(publication, api, enabled)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it('treats incomplete response ids as unknown even with a fake API', async () => {
    vi.spyOn(api, 'sendMedia').mockResolvedValue([]);
    expect(await deliverPublicationMedia(publication, api, enabled)).toBe(false);
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('SET status=$2'))?.[1])
      .toEqual(['batch', 'unknown', 'telegram_media_response_unknown', null]);
  });
  it('maintenance selects only known unsent, due attachment batches', async () => {
    await retryPublicationMedia(api, enabled, '-100123');
    expect(mocks.query.mock.calls[0]?.[0]).toContain("p.media_status='pending'");
    expect(mocks.query.mock.calls[0]?.[0]).toContain("b.status IN ('prepared','retryable')");
  });
  it('deletes only tracked ids, retaining the records after deletion', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...item, message_id: '10' }] });
    const remove = vi.spyOn(api, 'delete').mockResolvedValue(undefined);
    await deletePublicationMedia(publication, api);
    expect(remove).toHaveBeenCalledExactlyOnceWith('-100123', '10');
    expect(mocks.query.mock.calls[2]?.[0]).toContain('deleted_at=now()');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).startsWith('DELETE'))).toBe(false);
  });
  it('requires review before deleting a canonical message with unknown attachment ids', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ id: 'unknown batch' }] });
    const remove = vi.spyOn(api, 'delete');
    await expect(deletePublicationMedia(publication, api)).rejects.toMatchObject({ code: 'publication_media_requires_review' });
    expect(remove).not.toHaveBeenCalled();
  });
});
