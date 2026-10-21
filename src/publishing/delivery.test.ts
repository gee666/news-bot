import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { editPublication, reconcile, sendPrepared } from './delivery.js';
import { PublicationRenderError } from './render.js';
import type { Publication } from './store.js';
import { publicationSnapshotSchema } from '../types.js';
import { publicationAdmission } from './freshness.js';
import { publicationMedia } from '../media/story-media.js';
import * as mediaPlan from './media-plan.js';
import * as mediaDelivery from './media-delivery.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: mocks.transaction }));
vi.mock('../media/story-media.js', () => ({ publicationMedia: vi.fn().mockResolvedValue([]), releaseStoryMedia: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./freshness.js', () => ({ publicationAdmission: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock('./edit-reconciliation.js', () => ({ reconcileUnknownEdit: vi.fn().mockResolvedValue(null) }));
const publication: Publication = {
  id: 'id', story_id: 'story', snapshot_id: 'snap', pending_snapshot_id: null, format_version: 1, bot_id: '123', destination_id: '-100123', message_id: null,
  status: 'prepared', attempt_count: 0,
  created_at: new Date(), next_retry_at: null,
  content: { headline: 'Новость', score: 3, details: 'Текст', detailsKind: 'excerpt', sources: [] },
};

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(publicationMedia).mockReset().mockResolvedValue([]);
  vi.mocked(publicationAdmission).mockReset().mockResolvedValue({ allowed: true });
  vi.spyOn(BotApi.prototype,'identity').mockResolvedValue({ id: 123,is_bot: true });
  mocks.query.mockReset().mockImplementation(async (sql: string) => ({ rows:
    sql.includes('SELECT 1 FROM request_attempts') ? []
      : sql.includes('SELECT * FROM publications') ? [publication]
        : sql.includes('SELECT delivery_kind') ? [{ delivery_kind: 'text', media_status: 'none', media_snapshot_id: 'snap' }]
          : sql.includes('INSERT INTO request_attempts') ? [{ id: 'attempt' }] : [] }));
  mocks.transaction.mockReset().mockImplementation(async (run: (client: Pick<PoolClient,'query'>) => Promise<unknown>) => run({ query: mocks.query }));
});

describe('durable publication delivery', () => {
  it.each(['send', 'edit'] as const)('records preflight %s denials without attempts, dispatch or content', async operation => {
    vi.mocked(publicationAdmission).mockResolvedValue({ allowed: false, reason: 'consolidation_unresolved' });
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api, 'send'); const edit = vi.spyOn(api, 'edit');
    if (operation === 'send') expect(await sendPrepared(publication, api, defaultSettings)).toBeNull();
    else expect(await editPublication({ ...publication, status: 'published', message_id: '9' }, api, defaultSettings)).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
    const diagnostic = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO operational_state'));
    expect(JSON.parse(String(diagnostic?.[1]?.[1]))).toEqual({ publicationId: 'id', snapshotId: 'snap', operation,
      reason: 'consolidation_unresolved', at: expect.any(String), lastSeenAt: expect.any(String), occurrences: 1 });
  });
  it('records an admission change at the attempt boundary before any send', async () => {
    vi.mocked(publicationAdmission).mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({ allowed: false, reason: 'settings_changed' });
    const api = new BotApi('123:synthetic'); const send = vi.spyOn(api, 'send');
    expect(await sendPrepared(publication, api, defaultSettings)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO operational_state'))?.[1]?.[0])
      .toBe('publication_admission:id:snap:settings_changed');
  });
  it('saves sending and an attempt before sending and commits a known message id', async () => {
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api,'send').mockImplementation(async () => {
      expect(mocks.query.mock.calls.some(call => String(call[0]).includes("status='sending'"))).toBe(true);
      expect(mocks.query.mock.calls.some(call => String(call[0]).includes('INSERT INTO request_attempts'))).toBe(true);
      return '9';
    });
    expect(await sendPrepared(publication,api,defaultSettings)).toBe('9');
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes("status='published'"))).toBe(true);
  });

  it('does not send text when media preparation fails', async () => {
    vi.mocked(publicationMedia).mockRejectedValue(new Error('download failed'));
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api, 'send');
    expect(await sendPrepared(publication, api, defaultSettings)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE publications SET status=$2'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
  });

  it('retains legacy canonical text separate from media and does not report incomplete attachments as success', async () => {
    const api = new BotApi('123:synthetic');
    const events: string[] = [];
    vi.spyOn(mediaPlan, 'preparePublicationMedia').mockImplementation(async () => { events.push('prepare'); return true; });
    const send = vi.spyOn(api, 'send').mockImplementation(async () => { events.push('text'); return '9'; });
    vi.spyOn(mediaDelivery, 'deliverPublicationMedia').mockImplementation(async (canonical) => {
      events.push('media');
      expect(canonical).toMatchObject({ message_id: '9', status: 'published', bot_id: '123' });
      expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status='published'"))).toBe(true);
      return false;
    });
    const long = { ...publication, content: { headline: 'News', details: 'word '.repeat(600), score: 7, detailsKind: 'summary', sources: [] } };
    expect(await sendPrepared(long, api, defaultSettings)).toBeNull();
    expect(events).toEqual(['prepare', 'text', 'media']);
    expect(send.mock.calls[0]?.[1].plainText.length).toBeGreaterThan(1024);
  });

  it('sends a review-failed summary with a warning and commits it as published', async () => {
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api, 'send').mockResolvedValue('9');
    const failed = { ...publication, content: { ...publicationSnapshotSchema.parse(publication.content),
      review: { supported: false, reason: 'Версия не подтверждена источником' } } };
    expect(await sendPrepared(failed, api, defaultSettings)).toBe('9');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].text).toContain('Заметки проверяющего: Версия не подтверждена источником');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("status='published'"))).toBe(true);
  });

  it('records uncertain sends durably and reconciles only via channel reading, never a resend', async () => {
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api,'send').mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
    expect(await sendPrepared(publication,api,defaultSettings)).toBeNull();
    const failure = mocks.query.mock.calls.find(call => String(call[0]).includes('UPDATE publications SET status=$1'));
    expect(failure?.[1]?.[0]).toBe('uncertain');
    const reader = vi.fn().mockResolvedValue('10');
    expect(await reconcile({ ...publication, status: 'uncertain' },defaultSettings,reader)).toBe(true);
    expect(reader).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes('reconciled') || String(call[1]).includes('reconciled'))).toBe(true);
  });

  it('keeps a no-match send uncertain for explicit review rather than retrying', async () => {
    expect(await reconcile({ ...publication,status: 'uncertain' },defaultSettings,async () => null)).toBe(false);
    expect(mocks.query.mock.calls[0]?.[0]).toContain('send_not_found_requires_review');
    expect(mocks.query.mock.calls.some(call => String(call[0]).includes("status='prepared'"))).toBe(false);
  });

  it('respects Telegram retry-after durably', async () => {
    const api = new BotApi('123:synthetic');
    vi.spyOn(api,'send').mockRejectedValue(new BotError('telegram_rate_limit','retryable',120_000));
    const before = Date.now();
    await sendPrepared(publication,api,defaultSettings);
    const failure = mocks.query.mock.calls.find(call => String(call[0]).includes('UPDATE request_attempts SET status=$1'));
    expect(failure?.[1]?.[0]).toBe('retryable');
    expect(failure?.[1]?.[2].getTime()).toBeGreaterThanOrEqual(before+120_000);
  });

  it('trims oversized details for Telegram without dropping sources', async () => {
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api,'send').mockResolvedValue('9');
    const broken = { ...publication, content: { headline: 'Новость', score: 3, details: 'Текст'.repeat(1500), detailsKind: 'excerpt', sources: [{ label: 'Источник',
      url: 'https://example.org/', access: 'public', primary: false, classification: 'relevant' }] } };
    expect(await sendPrepared(broken,api,defaultSettings)).toBe('9');
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[1].plainText.length).toBeLessThanOrEqual(4096);
    expect(send.mock.calls[0]?.[1].text).toContain('https://example.org/');
  });

  it('persists terminal render failures without dispatching an edit', async () => {
    const api = new BotApi('123:synthetic');
    const edit = vi.spyOn(api,'edit').mockResolvedValue(undefined);
    const broken = { ...publication, status: 'published' as const, message_id: '9', content: { invalid: true } };
    await expect(editPublication(broken,api,defaultSettings)).rejects.toBeInstanceOf(PublicationRenderError);
    expect(edit).not.toHaveBeenCalled();
    const failure = mocks.query.mock.calls.find(call => String(call[0]).includes('UPDATE request_attempts SET status=$1'));
    expect(failure?.[1]?.slice(0,3)).toEqual(['failed','publication_snapshot_invalid',null]);
  });

  it('supersedes and inserts a replacement edit in one committed transaction before dispatch', async () => {
    const events: string[] = [];
    mocks.transaction.mockImplementation(async (run: (client: Pick<PoolClient,'query'>) => Promise<unknown>) => {
      events.push('begin');
      const value = await run({ query: mocks.query });
      events.push('commit');
      return value;
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('edit_superseded')) events.push('supersede');
      if (sql.includes('INSERT INTO request_attempts')) events.push('insert');
      return { rows: [{ id: 'attempt' }] };
    });
    const api = new BotApi('123:synthetic');
    vi.spyOn(api,'edit').mockImplementation(async () => { events.push('dispatch'); });
    await editPublication({ ...publication,status: 'published',message_id: '9' },api,defaultSettings);
    expect(events.slice(0,7)).toEqual(['begin','commit','begin','supersede','insert','commit','dispatch']);
  });

  it('edits solely from the stored snapshot and records desired snapshot for restart retry', async () => {
    const api = new BotApi('123:synthetic');
    const edit = vi.spyOn(api,'edit').mockRejectedValue(new BotError('telegram_transport_unknown','unknown'));
    expect(await editPublication({ ...publication, status: 'published', message_id: '9', story_id: null },api,defaultSettings)).toBe(false);
    expect(edit.mock.calls[0]?.[2].text).toContain('Текст');
    expect(edit.mock.calls[0]?.[2].reply_markup.inline_keyboard).toEqual([]);
    const attempt = mocks.query.mock.calls.find(call => String(call[0]).includes('INSERT INTO request_attempts'));
    expect(JSON.parse(String(attempt?.[1]?.[2]))).toMatchObject({ snapshotId:'snap',fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(mocks.query.mock.calls.every(call => !/FROM (stories|source_items|story_mentions)/u.test(String(call[0])))).toBe(true);
  });
});
