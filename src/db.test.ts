import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn<(...args: unknown[]) => Promise<{ rows: { checksum: string }[] }>>(),
  release: vi.fn(),
  connect: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));
vi.mock('pg', () => ({
  default: { Pool: class {
    connect = mocks.connect;
    on = vi.fn();
  } },
}));
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile, readdir: mocks.readdir }));

import { createHash } from 'node:crypto';
import { migrate, transaction } from './db.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
  mocks.query.mockResolvedValue({ rows: [] });
  mocks.readdir.mockResolvedValue(['002_more.sql', 'notes.md', '001_core.sql']);
  mocks.readFile.mockResolvedValue('SELECT 1;');
});

describe('transaction', () => {
  it('commits and releases the connection', async () => {
    const result = await transaction(async client => {
      await client.query('SELECT 42');
      return 42;
    });
    expect(result).toBe(42);
    expect(mocks.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'SELECT 42', 'COMMIT']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('rolls back, releases, and preserves the original failure', async () => {
    const failure = new Error('stage failed');
    await expect(transaction(async () => { throw failure; })).rejects.toBe(failure);
    expect(mocks.query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});

describe('migrate', () => {
  it('applies sorted SQL files in separate transactions under a lock', async () => {
    await migrate();
    const names = mocks.query.mock.calls
      .filter(call => typeof call[0] === 'string' && call[0].startsWith('INSERT INTO schema_migrations'))
      .map(call => Array.isArray(call[1]) ? call[1][0] : null);
    expect(names).toEqual(['001_core.sql', '002_more.sql']);
    expect(mocks.query).toHaveBeenCalledWith('SELECT pg_advisory_lock(736428109)');
    expect(mocks.query).toHaveBeenCalledWith('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('%I.schema_migrations'));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('current_schema()'));
    expect(mocks.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock(736428109)');
    expect(mocks.query.mock.calls.filter(call => call[0] === 'COMMIT')).toHaveLength(2);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it('keeps same-number migration filenames independent and replays both safely', async () => {
    mocks.readdir.mockResolvedValue(['110_evidence_read_history.sql', '100_source_research_defaults.sql', '100_model_usage.sql']);
    mocks.readFile.mockImplementation(async (path: string) => 'SQL for ' + path.split('/').at(-1));
    const applied = new Map<string, string>();
    mocks.query.mockImplementation(async (...args) => {
      const name = Array.isArray(args[1]) ? args[1][0] : undefined;
      const checksum = Array.isArray(args[1]) ? args[1][1] : undefined;
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO schema_migrations')
        && typeof name === 'string' && typeof checksum === 'string') applied.set(name, checksum);
      return { rows: typeof args[0] === 'string' && args[0].startsWith('SELECT checksum')
        && typeof name === 'string' && applied.has(name) ? [{ checksum: applied.get(name) ?? '' }] : [] };
    });
    await migrate();
    expect([...applied.keys()]).toEqual(['100_model_usage.sql', '100_source_research_defaults.sql', '110_evidence_read_history.sql']);
    expect(new Set(applied.values()).size).toBe(3);
    expect(mocks.query.mock.calls.filter(call => call[0] === 'COMMIT')).toHaveLength(3);
    await migrate();
    expect(mocks.query.mock.calls.filter(call => call[0] === 'COMMIT')).toHaveLength(3);
    expect(mocks.query.mock.calls.filter(call => typeof call[0] === 'string'
      && call[0].startsWith('INSERT INTO schema_migrations'))).toHaveLength(3);
  });

  it('skips matching migrations and rejects modified applied SQL', async () => {
    const checksum = createHash('sha256').update('SELECT 1;').digest('hex');
    mocks.query.mockImplementation(async (...args) => ({
      rows: typeof args[0] === 'string' && args[0].startsWith('SELECT checksum') ? [{ checksum }] : [],
    }));
    await migrate();
    expect(mocks.query).not.toHaveBeenCalledWith('BEGIN');
    mocks.query.mockImplementation(async (...args) => ({
      rows: typeof args[0] === 'string' && args[0].startsWith('SELECT checksum') ? [{ checksum: 'changed' }] : [],
    }));
    await expect(migrate()).rejects.toThrow('Applied migration changed: 001_core.sql');
    expect(mocks.query).toHaveBeenLastCalledWith('SELECT pg_advisory_unlock(736428109)');
  });

  it('rolls back a failed migration without recording it', async () => {
    mocks.query.mockImplementation(async (...args) => {
      if (args[0] === 'SELECT 1;') throw new Error('SQL rejected');
      return { rows: [] };
    });
    await expect(migrate()).rejects.toThrow('SQL rejected');
    expect(mocks.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mocks.query.mock.calls.some(call =>
      typeof call[0] === 'string' && call[0].startsWith('INSERT INTO schema_migrations'))).toBe(false);
    expect(mocks.release).toHaveBeenCalledOnce();
  });
});
