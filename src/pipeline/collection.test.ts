import { expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { collectBatch, collectionFailure } from './collection.js';
it('retains provider flood wait and bounded connection retries', () => {
  expect(collectionFailure(new Error('FLOOD_WAIT_3600'), 1, defaultSettings).next?.getTime())
    .toBeGreaterThanOrEqual(Date.now() + 3_599_000);
  expect(collectionFailure(new Error('FLOOD_WAIT_3600'), defaultSettings.requestMaxAttempts, defaultSettings).next).toBeNull();
  expect(collectionFailure(new Error('ECONNRESET'), 1, defaultSettings).next).toBeInstanceOf(Date);
  expect(collectionFailure(new Error('ECONNRESET'), defaultSettings.requestMaxAttempts, defaultSettings).next).toBeNull();
});
it('does not retain connector error bodies or retry authentication indefinitely', () => {
  const result = collectionFailure(new Error('AUTH_KEY_UNREGISTERED secret-body'), 1, defaultSettings);
  expect(result.next).toBeNull();
  expect(JSON.stringify(result)).not.toContain('secret-body');
});

const mocks=vi.hoisted(()=>({query:vi.fn(),collect:vi.fn()}));
vi.mock('../db.js',()=>({db:{query:mocks.query}}));
vi.mock('../telegram/batch.js',()=>({collectTelegramBatch:mocks.collect}));
it('does not dispatch Telegram after an exhausted scheduled-collection budget',async () => {
  mocks.query.mockImplementation(async (sql:string)=>({rows:sql.includes('primary_collection_completed_at')
    ? [{primary_collection_completed_at:new Date()}] : sql.includes('MAX(attempt_number)') ? [{attempt:defaultSettings.requestMaxAttempts+1}] : []}));
  await expect(collectBatch('batch',new Date(),defaultSettings)).rejects.toThrow('Stage retry limit reached');
  expect(mocks.collect).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("status='failed'"))).toBe(true);
});
it('reuses successful Telegram collection across more checkpoints than the retry budget',async () => {
  vi.clearAllMocks();
  let completed=false;
  let dispatches=0;
  mocks.collect.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql:string) => {
    if (sql.includes('primary_collection_completed_at')) return {rows:[{primary_collection_completed_at:new Date()}]};
    if (sql.includes('MAX(attempt_number)')) return {rows:[{attempt:dispatches+1,completed}]};
    if (sql.includes('SELECT max(next_retry_at)')) {
      // An unrelated flood wait must not hold an already collected batch on later slices.
      return {rows:[{next:completed ? new Date(Date.now()+3_600_000) : null}]};
    }
    if (sql.includes('INSERT INTO request_attempts')) { dispatches++; return {rows:[{id:'receipt'}]}; }
    if (sql.includes("SET status='succeeded'")) completed=true;
    return {rows:[]};
  });
  const cutoff=new Date();
  for(let checkpoint=0;checkpoint<defaultSettings.requestMaxAttempts+3;checkpoint++) {
    await expect(collectBatch('batch',cutoff,defaultSettings)).resolves.toBeUndefined();
  }
  expect(mocks.collect).toHaveBeenCalledExactlyOnceWith('batch',cutoff,defaultSettings.collectionWindowHours);
  expect(dispatches).toBe(1);
  expect(mocks.query.mock.calls.filter(([sql])=>String(sql).includes('SELECT max(next_retry_at)'))).toHaveLength(1);
  expect(mocks.query.mock.calls.some(([sql])=>String(sql).includes("status='failed'"))).toBe(false);
});
