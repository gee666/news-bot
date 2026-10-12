import { beforeEach, expect, it, vi } from 'vitest';
import { collectBatch } from './collection.js';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ primary: vi.fn(), telegram: vi.fn(), query: vi.fn() }));
vi.mock('../sources/collector.js', () => ({ collectPrimarySources: mocks.primary }));
vi.mock('../telegram/batch.js', () => ({ collectTelegramBatch: mocks.telegram }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: vi.fn() }));
beforeEach(() => { mocks.primary.mockReset(); mocks.telegram.mockReset(); mocks.query.mockReset(); });
it('scheduled dispatcher collects publishers before isolated Telegram failure and retains Telegram retry accounting', async () => {
  mocks.primary.mockResolvedValue({ collected: 1, failed: 1 });
  mocks.query.mockResolvedValue({ rows: [{ attempt: 1, id: 'request' }] });
  mocks.telegram.mockRejectedValue(new Error('ECONNRESET'));
  await expect(collectBatch('batch', new Date('2026-10-01T12:00:00Z'), defaultSettings)).rejects.toThrow('ECONNRESET');
  expect(mocks.primary).toHaveBeenCalledTimes(1);
  expect(mocks.telegram).toHaveBeenCalledTimes(1);
  expect(mocks.primary.mock.invocationCallOrder[0]).toBeLessThan(mocks.telegram.mock.invocationCallOrder[0] ?? 0);
  expect(mocks.query.mock.calls.some(call => call[0].includes('request_attempts'))).toBe(true);
});
it('records partial primary intake once and never re-fetches failed sources at processing checkpoints', async () => {
  let finished = false;
  mocks.primary.mockResolvedValue({ collected: 1, failed: 1 }); mocks.telegram.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT primary_collection_completed_at')) return { rows: [{ primary_collection_completed_at: finished ? new Date() : null }] };
    if (sql.includes('SET primary_collection_completed_at=now()')) finished = true;
    return { rows: [] };
  });
  await collectBatch('batch', new Date(), defaultSettings);
  await collectBatch('batch', new Date(), defaultSettings);
  expect(mocks.primary).toHaveBeenCalledOnce();
  expect(mocks.query.mock.calls.some(([sql, args]) => String(sql).includes('partial_source_failure')
    && args?.[1] === 1 && String(args?.[2]).includes('next intake'))).toBe(true);
});
it('preserves a primary collection receipt even while Telegram waits', async () => {
  mocks.primary.mockResolvedValue({ collected: 1, failed: 1 }); mocks.telegram.mockRejectedValue(new Error('ECONNRESET'));
  mocks.query.mockResolvedValue({ rows: [] });
  await expect(collectBatch('batch', new Date(), defaultSettings)).rejects.toThrow('ECONNRESET');
  expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('SET primary_collection_completed_at=now()'))).toBe(true);
});
