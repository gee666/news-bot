import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tryLocked } from './store.js';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), release: vi.fn() }));
vi.mock('../db.js', () => ({ db: { connect: mocks.connect } }));

beforeEach(() => {
  mocks.query.mockReset();
  mocks.release.mockReset();
  mocks.connect.mockReset().mockResolvedValue({ query: mocks.query, release: mocks.release });
});

describe('nonblocking publication maintenance lease', () => {
  it('skips a busy digest without waiting or unlocking another session', async () => {
    mocks.query.mockResolvedValue({ rows: [{ acquired: false }] });
    const run = vi.fn();
    await tryLocked('news-bot-digest',run);
    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0]?.[0]).toContain('pg_try_advisory_lock');
    expect(run).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('releases an acquired lease even when maintenance fails', async () => {
    mocks.query.mockResolvedValue({ rows: [{ acquired: true }] });
    await expect(tryLocked('news-bot-digest',async () => { throw new Error('Failure'); })).rejects.toThrow('Failure');
    expect(mocks.query.mock.calls[1]?.[0]).toContain('pg_advisory_unlock');
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
