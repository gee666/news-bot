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
it('does not revive terminal or exhausted operation markers during recovery', async () => {
  for (const phase of ['failed','running']) {
    mocks.state={ phase,attempt: 5 };
    const run=vi.fn();
    expect(await operationalWork('pipeline_digest',defaultSettings,false,run)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  }
});

it('backs off and stops after the configured failures, but an explicit new run can recover', async () => {
  const run=vi.fn().mockRejectedValue(new Error('offline'));
  for (let attempt=1; attempt<=defaultSettings.requestMaxAttempts; attempt++) {
    await expect(operationalWork('pipeline_digest',defaultSettings,false,run)).rejects.toThrow('offline');
    expect(mocks.state).toMatchObject({attempt,phase:attempt<defaultSettings.requestMaxAttempts ? 'waiting' : 'failed'});
    await vi.advanceTimersByTimeAsync(defaultSettings.retryBaseMs * 2 ** (attempt-1)+1);
  }
  expect(await operationalWork('pipeline_digest',defaultSettings,false,run)).toBe(false);
  expect(run).toHaveBeenCalledTimes(defaultSettings.requestMaxAttempts);
  run.mockResolvedValue(undefined);
  expect(await operationalWork('pipeline_digest',defaultSettings,true,run)).toBe(true);
});
