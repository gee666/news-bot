import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverUsage, retryUsageWrites, startUsageRecovery, usageRecoveryInterval } from './usage-delivery.js';
import { recordUsage, type UsageCall } from './usage.js';

vi.mock('./usage.js', async importOriginal => ({
  ...await importOriginal<typeof import('./usage.js')>(), recordUsage: vi.fn(async () => {}),
}));
const paths: string[] = [];
let stop: (() => Promise<void>) | undefined;
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers({toFake:['Date']}); });
afterEach(async () => {
  await stop?.(); stop = undefined;
  vi.useRealTimers(); vi.unstubAllEnvs();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function directory(): Promise<string> {
  const path = await mkdtemp(resolve('tmp/usage-outbox-')); paths.push(path); return path;
}
function call(): UsageCall {
  return { id: randomUUID(), timestamp: '2026-01-01T00:00:00.000Z', provider: 'jev', model: 'judge',
    operationId: 'operation', stage: 'interest', attempt: 1, outcome: 'completed', usageKnown: true,
    inputTokens: 50, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 10, totalTokens: 105,
    estimatedCost: null, actualBilledCost: null, durationMs: 10 };
}

describe('usage storage recovery', () => {
  it('needs no outbox file for a successful database write', async () => {
    const path = await directory();
    const report = vi.fn();
    await deliverUsage(call(), { directory: path, report });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    expect(await readdir(path)).toEqual([]);
  });

  it('persists a private record and replays it from disk with its original ID after repeated failures', async () => {
    const path = await directory();
    const entry = call();
    const report = vi.fn();
    const writer = vi.fn<(_: UsageCall) => Promise<void>>()
      .mockRejectedValueOnce(new Error('PRIVATE_CONNECTION_URL'))
      .mockRejectedValueOnce(new Error('PRIVATE_CONNECTION_URL')).mockResolvedValue(undefined);
    await deliverUsage(entry, { directory: path, record: writer, report });
    const file = join(path, entry.id + '.json');
    expect((await lstat(file)).mode & 0o077).toBe(0);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({...entry,_delivery:{attempts:1,next:expect.any(String)}});
    vi.setSystemTime(Date.now()+30_001);
    expect(await retryUsageWrites({ directory: path, record: writer, report })).toBe(0);
    expect(await readdir(path)).toEqual([entry.id + '.json']);
    expect(await retryUsageWrites({ directory: path, record: writer, report })).toBe(0);
    expect(writer).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now()+60_001);
    expect(await retryUsageWrites({ directory: path, record: writer, report })).toBe(1);
    expect(await readdir(path)).toEqual([]);
    expect(writer.mock.calls.map(([value]) => value.id)).toEqual([entry.id, entry.id, entry.id]);
    expect(JSON.stringify(report.mock.calls)).not.toContain('PRIVATE_');
  });

  it('pauses a recovery pass on database failure instead of retrying every queued call during an outage', async () => {
    const path = await directory();
    const report = vi.fn();
    const entries = [call(), call()];
    for (const entry of entries) await deliverUsage(entry, { directory: path, report,
      record: async () => { throw new Error('Database offline'); } });
    vi.setSystemTime(Date.now()+30_001);
    const offline = vi.fn(async () => { throw new Error('Database offline'); });
    expect(await retryUsageWrites({ directory: path, report, record: offline })).toBe(0);
    expect(offline).toHaveBeenCalledOnce();
    expect(await readdir(path)).toHaveLength(2);
    vi.setSystemTime(Date.now()+60_001);
    expect(await retryUsageWrites({ directory: path, report })).toBe(2);
    expect(await readdir(path)).toEqual([]);
  });

  it('reports filesystem failure independently without changing the completed inference result', async () => {
    const path = await directory();
    await chmod(path, 0o755);
    const entry = call();
    const report = vi.fn();
    await expect(deliverUsage(entry, { directory: path, report,
      record: async () => { throw new Error('PRIVATE_DATABASE_ERROR'); } })).resolves.toBeUndefined();
    expect(report.mock.calls).toEqual([[entry.id, 'database_write'], [entry.id, 'outbox_write']]);
  });

  it('retains invalid records for inspection without inserting them or logging their content', async () => {
    const path = await directory();
    const id = randomUUID();
    await writeFile(join(path, id + '.json'), 'PRIVATE_INVALID_JSON', { mode: 0o600 });
    const report = vi.fn();
    expect(await retryUsageWrites({ directory: path, report })).toBe(0);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(report.mock.calls).toEqual([[id, 'outbox_read']]);
    expect(await readdir(path)).toEqual([id + '.json.failed']);
  });

  it('runs storage-only recovery on startup and drains before shutdown', async () => {
    const path = await directory();
    vi.stubEnv('MODEL_USAGE_OUTBOX_DIR', path);
    const entry = call();
    vi.mocked(recordUsage).mockRejectedValueOnce(new Error('PRIVATE_DATABASE_ERROR')).mockResolvedValue(undefined);
    await deliverUsage(entry, { directory: path, report: vi.fn() });
    vi.setSystemTime(Date.now()+30_001);
    stop = startUsageRecovery(1000);
    await stop(); stop = undefined;
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(recordUsage).mock.calls[1]?.[0]).toEqual(entry);
    expect(await readdir(path)).toEqual([]);
  });

  it('validates the configurable storage retry interval', () => {
    vi.stubEnv('MODEL_USAGE_RETRY_MS', '');
    expect(() => usageRecoveryInterval()).toThrow();
    vi.stubEnv('MODEL_USAGE_RETRY_MS', '5000');
    expect(usageRecoveryInterval()).toBe(5000);
  });
});

it('stops replaying exhausted writes and retains their bytes for inspection', async () => {
  const path=await directory(); const entry=call(); const report=vi.fn();
  const record=vi.fn(async () => {throw new Error('offline');});
  const options={directory:path,record,report};
  await deliverUsage(entry,options);
  for (const delay of [30_001,60_001,120_001]) {
    vi.setSystemTime(Date.now()+delay); await retryUsageWrites(options);
  }
  expect(record).toHaveBeenCalledTimes(3);
  expect(await readdir(path)).toEqual([entry.id+'.json.failed']);
  expect(JSON.parse(await readFile(join(path,entry.id+'.json.failed'),'utf8'))).toMatchObject(entry);
});
it('replays legacy outbox records without moving their deadline forward on every scan', async () => {
  const path=await directory(); const entry=call(); const record=vi.fn(async () => {});
  await writeFile(join(path,entry.id+'.json'),JSON.stringify(entry),{mode:0o600});
  expect(await retryUsageWrites({directory:path,record})).toBe(1);
  expect(record).toHaveBeenCalledWith(entry);
});
