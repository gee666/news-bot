import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { defaultSettings } from '../settings.js';
import { BotApi, BotError } from './bot-api.js';
import { deliverMediaFirst } from './media-first-delivery.js';
import type { Publication } from './store.js';

const mocks = vi.hoisted(() => ({ query:vi.fn(), admission:vi.fn() }));
vi.mock('../db.js', () => ({ db:{ query:mocks.query },
  transaction:async (run: (client: Pick<PoolClient,'query'>) => Promise<unknown>) => run({ query:mocks.query }) }));
vi.mock('../media/story-media.js', () => ({ releaseStoryMedia:vi.fn().mockResolvedValue(undefined) }));
vi.mock('./freshness.js', () => ({ publicationAdmission:mocks.admission, recordAdmissionDenial:vi.fn() }));
vi.mock('./destination-order.js', () => ({ destinationBlocked:vi.fn().mockResolvedValue(false), reserveDestination:vi.fn().mockResolvedValue(true) }));
vi.mock('./store.js', () => ({ settleExpiredPublications: async () => [], rateLimited:vi.fn().mockResolvedValue(false) }));
const publication: Publication = { id:'pub',story_id:'story',snapshot_id:'snap',pending_snapshot_id:null,
  destination_id:'-100123',status:'prepared',message_id:null,bot_id:'123',format_version:1,attempt_count:0,
  next_retry_at:null,created_at:new Date(),content:{},delivery_kind:'media_first',media_status:'pending' };
const item = { id:'item',type:'image',mime_type:'image/png',digest:'digest',data:Buffer.from('png'),expires_at:new Date(Date.now()+60_000) };
const batch: { id:string;batch_number:number;status:string;attempt_count:number;next_retry_at:Date|null } = { id:'batch',batch_number:0,status:'prepared',attempt_count:0,next_retry_at:null };
let batches: Array<typeof batch>;
let items: Array<typeof item>;
let api: BotApi;
beforeEach(() => {
  vi.restoreAllMocks(); batches=[{ ...batch }]; items=[{ ...item }];
  mocks.admission.mockReset().mockResolvedValue({ allowed:true });
  mocks.query.mockReset().mockImplementation(async (sql: string) => ({ rows:
    sql.includes('SELECT * FROM publication_media_batches') ? batches
      : sql.includes('count(*)') ? [{ count:items.length }]
        : sql.includes('SELECT * FROM publication_media_items') ? items
          : sql.includes('RETURNING id') ? [{ id:'attempt' }] : [] }));
  api=new BotApi('123:synthetic');
  vi.spyOn(api,'identity').mockResolvedValue({ id:123,is_bot:true });
  vi.spyOn(api,'sendMedia').mockResolvedValue(['100']);
});
function mediaOutcome() {
  return mocks.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE publications SET media_status=$2'))?.[1];
}

describe('terminal media fallback', () => {
  it.each(['unknown','failed'])('skips a persisted %s batch without resending or inventing media receipts', async status => {
    batches[0] = { ...batch,status };
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(true);
    expect(api.sendMedia).not.toHaveBeenCalled();
    expect(mediaOutcome()).toEqual(['pub',status,status === 'unknown' ? 'publication_media_requires_review' : 'publication_media_failed']);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('SET message_id='))).toBe(false);
  });
  it.each(['unknown','failed'] as const)('continues other batches after a %s upload but keeps its terminal diagnosis', async outcome => {
    batches.push({ ...batch,id:'batch2',batch_number:1 });
    vi.mocked(api.sendMedia).mockRejectedValueOnce(new BotError('telegram_rejected',outcome)).mockResolvedValue(['101']);
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(true);
    expect(api.sendMedia).toHaveBeenCalledTimes(2);
    expect(mediaOutcome()?.[1]).toBe(outcome);
    expect(mocks.query.mock.calls.filter(([sql]) => String(sql).includes('SET message_id='))).toHaveLength(1);
  });
  it('treats a malformed upload receipt as unknown and permits canonical text', async () => {
    vi.mocked(api.sendMedia).mockResolvedValue([]);
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(true);
    expect(mediaOutcome()?.[1]).toBe('unknown');
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('SET message_id='))).toBe(false);
  });
  it('still waits for a running upload rather than sending past it', async () => {
    batches[0] = { ...batch,status:'running' };
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(false);
    expect(api.sendMedia).not.toHaveBeenCalled();
  });
  it('honors retry-after before another upload', async () => {
    batches[0] = { ...batch,status:'retryable',next_retry_at:new Date(Date.now()+120_000) };
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(false);
    expect(api.sendMedia).not.toHaveBeenCalled();
  });
  it.each(['expired','missing'])('fails %s upload bytes without waiting for retry-after or blocking text', async reason => {
    batches[0] = { ...batch,status:'retryable',next_retry_at:new Date(Date.now()+120_000) };
    items = reason === 'missing' ? [] : [{ ...item,expires_at:new Date(0) }];
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(true);
    expect(api.sendMedia).not.toHaveBeenCalled();
    expect(mediaOutcome()?.[1]).toBe('failed');
    expect(mocks.query.mock.calls.find(([sql]) => String(sql).includes("SET status='failed'"))?.[1])
      .toEqual(['batch','publication_media_expired']);
  });
  it('bounds rejected uploads with requestMaxAttempts while preserving the actual attempt outcome', async () => {
    batches[0] = { ...batch,attempt_count:defaultSettings.requestMaxAttempts-1 };
    vi.mocked(api.sendMedia).mockRejectedValue(new BotError('telegram_rate_limit','retryable',120_000));
    expect(await deliverMediaFirst(publication,api,defaultSettings,{})).toBe(true);
    expect(api.sendMedia).toHaveBeenCalledOnce();
    const attempt=mocks.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE request_attempts SET status=$2'));
    expect(attempt?.[1]).toEqual(['attempt','retryable','telegram_rate_limit',expect.any(Date)]);
    expect(attempt?.[1][3].getTime()).toBeGreaterThan(Date.now()+119_000);
    const failedBatch=mocks.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE publication_media_batches SET status=$2'));
    expect(failedBatch?.[1]).toEqual(['batch','failed','publication_media_retry_exhausted',null]);
    expect(mediaOutcome()?.[1]).toBe('failed');
  });
  it('retains terminal preparation diagnostics when no upload batch could be created', async () => {
    batches=[]; items=[];
    expect(await deliverMediaFirst({ ...publication,media_status:'failed' },api,defaultSettings,{})).toBe(true);
    expect(mediaOutcome()?.[1]).toBe('failed');
    expect(api.sendMedia).not.toHaveBeenCalled();
  });
});
