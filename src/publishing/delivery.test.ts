import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings as baseSettings } from '../settings.js';
const defaultSettings = { ...baseSettings, publishingEnabled: true };
import { BotApi, BotError } from './bot-api.js';
import { editPublication, reconcile, sendPrepared } from './delivery.js';
import * as mediaPlan from './media-plan.js';
import type { Publication } from './store.js';
import { publicationSnapshotSchema } from '../types.js';
import { publicationAdmission } from './freshness.js';
import { publicationMedia } from '../media/story-media.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
vi.mock('./store.js', async original => ({ ...await original<typeof import('./store.js')>(), settleExpiredPublications: async () => [] }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: mocks.transaction }));
vi.mock('../media/story-media.js', () => ({ publicationMedia: vi.fn().mockResolvedValue([]), releaseStoryMedia: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./freshness.js', async importOriginal => ({ ...await importOriginal<typeof import('./freshness.js')>(), publicationAdmission: vi.fn().mockResolvedValue({ allowed: true }) }));
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
    vi.mocked(publicationAdmission).mockResolvedValue({ allowed: false, reason: 'story_ineligible' });
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api, 'send'); const edit = vi.spyOn(api, 'edit');
    if (operation === 'send') expect(await sendPrepared(publication, api, defaultSettings)).toBeNull();
    else expect(await editPublication({ ...publication, status: 'published', message_id: '9' }, api, defaultSettings)).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(edit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
    const diagnostic = mocks.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO operational_state'));
    expect(JSON.parse(String(diagnostic?.[1]?.[1]))).toEqual({ publicationId: 'id', snapshotId: 'snap', operation,
      reason: 'story_ineligible', at: expect.any(String), lastSeenAt: expect.any(String), occurrences: 1 });
  });
  it('records an admission change at the attempt boundary before any send', async () => {
    vi.mocked(publicationAdmission).mockResolvedValue({ allowed: false, reason: 'settings_changed' });
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
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE publications SET error_code=$2'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
  });


  it('continues canonical text after a permanent preparation failure without failing the publication', async () => {
    vi.mocked(publicationMedia).mockRejectedValue(new BotError('publication_media_expired','failed'));
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api,'send').mockResolvedValue('9');
    expect(await sendPrepared(publication,api,defaultSettings)).toBe('9');
    expect(send).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes('SET media_status=$2'))?.[1])
      .toEqual(['id','failed','publication_media_expired']);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET status='failed'"))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE publications SET status=$2'))).toBe(false);
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

  it('rejects oversized text before dispatch rather than moving sources to replies', async () => {
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api,'send').mockResolvedValue('9');
    const broken = { ...publication, content: { headline: 'Новость', score: 3, details: 'Текст'.repeat(1500), detailsKind: 'excerpt', sources: [{ label: 'Источник',
      url: 'https://example.org/', access: 'public', primary: false, classification: 'relevant' }] } };
    expect(await sendPrepared(broken,api,defaultSettings)).toBeNull();
    expect(send).not.toHaveBeenCalled();
    const parts = mocks.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO publication_text_parts'));
    expect(parts).toHaveLength(0);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes("SET status='failed'"))?.[1])
      .toEqual(['id','publication_message_too_long']);
  });

  it('rejects oversized media-first text before uploading any media', async () => {
    vi.spyOn(mediaPlan,'preparePublicationMedia').mockResolvedValue(true);
    const original = mocks.query.getMockImplementation();
    mocks.query.mockImplementation(async (sql:string) => sql.includes('SELECT delivery_kind')
      ? { rows:[{ delivery_kind:'media_first',media_status:'pending',media_snapshot_id:'snap' }] } : original?.(sql));
    const api = new BotApi('123:synthetic');
    const send = vi.spyOn(api,'send'); const upload = vi.spyOn(api,'sendMedia');
    const long = { ...publication,content:{ headline:'Новость',score:7,details:'Факт. '.repeat(1000),detailsKind:'summary',sources:[] } };
    expect(await sendPrepared(long,api,defaultSettings)).toBeNull();
    expect(send).not.toHaveBeenCalled(); expect(upload).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO request_attempts'))).toBe(false);
  });

  it('persists terminal render failures without dispatching an edit', async () => {
    const api = new BotApi('123:synthetic');
    const edit = vi.spyOn(api,'edit').mockResolvedValue(undefined);
    const broken = { ...publication, status: 'published' as const, message_id: '9', content: { invalid: true } };
    expect(await editPublication(broken,api,defaultSettings)).toBe(false);
    expect(edit).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('publication_navigation_requires_new_edition'))).toBe(true);
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
      return { rows: sql.includes('publication_destination_reservations') ? [] : [{ id: 'attempt' }] };
    });
    const api = new BotApi('123:synthetic');
    vi.spyOn(api,'edit').mockImplementation(async () => { events.push('dispatch'); });
    await editPublication({ ...publication,status: 'published',message_id: '9' },api,defaultSettings);
    expect(events.slice(0,7)).toEqual(['begin','supersede','insert','commit','dispatch','begin','commit']);
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
