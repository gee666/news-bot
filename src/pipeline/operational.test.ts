import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { defaultSettings } from '../settings.js';
import { operationalWork, OperationalDeferred } from './operational.js';
const mocks = vi.hoisted(() => ({ query: vi.fn(), state: null as unknown }));
vi.mock('../db.js', () => ({ db: { query: mocks.query } }));
vi.mock('./processing-diagnostics.js', () => ({ recordProcessingDiagnostic: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); mocks.state=null;
  mocks.query.mockImplementation(async (sql: string, args: string[]) => {
    if (sql.startsWith('SELECT')) return { rows: mocks.state ? [{ value: mocks.state }] : [] };
    mocks.state=JSON.parse(args[1] ?? 'null'); return { rows: [] };
  });
});
afterEach(() => vi.useRealTimers());
it('retries infrastructure failures automatically without provider-specific health checks', async () => {
  const run=vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
  await expect(operationalWork('pipeline_digest',defaultSettings,false,run)).rejects.toThrow();
  expect(mocks.state).toMatchObject({ phase: 'waiting', attempt: 1 });
  expect(await operationalWork('pipeline_digest',defaultSettings,false,run)).toBe(false);
  await vi.advanceTimersByTimeAsync(defaultSettings.retryBaseMs+1);
  expect(await operationalWork('pipeline_digest',defaultSettings,false,run)).toBe(true);
  expect(mocks.state).toMatchObject({ phase: 'completed', attempt: 0 });
});
it('a busy lease does not consume a failure attempt', async () => {
  expect(await operationalWork('pipeline_digest',defaultSettings,false,async () => {
    throw new OperationalDeferred('busy');
  })).toBe(false);
  expect(mocks.state).toMatchObject({ phase: 'waiting', attempt: 0, code: 'lease_busy' });
});
it('recovers legacy failed and interrupted operation markers without approval', async () => {
  for (const phase of ['failed','running']) {
    mocks.state={ phase,attempt: 5 };
    expect(await operationalWork('pipeline_digest',defaultSettings,false,async () => {})).toBe(true);
  }
});
