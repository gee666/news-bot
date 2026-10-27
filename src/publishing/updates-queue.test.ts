import { beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), edit: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query }, transaction: async (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
vi.mock('./store.js', async original => ({ ...await original<typeof import('./store.js')>(),
  rateLimited: async () => false, locked: async (_name: string, run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
vi.mock('./delivery.js', () => ({ editPublication: mocks.edit }));
import { BotApi } from './bot-api.js';
import { retryEdits } from './updates.js';

beforeEach(() => {
  vi.restoreAllMocks(); mocks.query.mockReset(); mocks.edit.mockReset().mockResolvedValue(false);
  vi.spyOn(BotApi.prototype, 'identity').mockResolvedValue({ id: 123, is_bot: true });
  mocks.query.mockImplementation(async (sql: string) => ({ rows:
    sql.startsWith('SELECT p.id FROM publications') && sql.includes('ORDER BY CASE') ? [{ id: 'post' }]
      : sql.includes('SELECT p.*, s.content') ? [{ id: 'post', bot_id: '123' }] : [] }));
});
it('limits automatic edit recovery to one post and backs off unresolved reads', async () => {
  await retryEdits(new BotApi('123:synthetic'), defaultSettings, '-100123');
  const selection = mocks.query.mock.calls.find(([sql]) => sql.startsWith('SELECT p.id FROM publications') && sql.includes('ORDER BY CASE'));
  expect(selection?.[0]).toContain('LIMIT 1');
  expect(mocks.edit).toHaveBeenCalledOnce();
  expect(mocks.query.mock.calls.some(([sql, args]) => sql.startsWith('UPDATE request_attempts SET next_retry_at=')
    && sql.includes("status='unknown'") && sql.includes('reconciliationAttempts')
    && sql.includes('21600000') && args[1] === defaultSettings.retryBaseMs)).toBe(true);
});
it('does not cap the explicitly selected manual edit scope', async () => {
  await retryEdits(new BotApi('123:synthetic'), defaultSettings, '-100123', ['story']);
  const selection = mocks.query.mock.calls.find(([sql]) => sql.startsWith('SELECT p.id FROM publications') && sql.includes('ORDER BY CASE'));
  expect(selection?.[0]).not.toContain('LIMIT 1');
});
