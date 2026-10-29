import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeUsageOutbox, startUsageRecovery } from './usage-delivery.js';
import { usageOutboxStatus, usageOutboxStatusSchema } from './usage-outbox-status.js';

vi.mock('./usage.js', async importOriginal => ({
  ...await importOriginal<typeof import('./usage.js')>(), recordUsage: vi.fn(async () => {}),
}));
let root: string;
let path: string;
let stop: (() => Promise<void>) | undefined;
beforeEach(async () => {
  root = await mkdtemp(resolve('tmp/usage-monitor-'));
  path = join(root, 'private-outbox');
  vi.stubEnv('MODEL_USAGE_OUTBOX_DIR', path);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await stop?.(); stop = undefined;
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('private usage outbox monitor', () => {
  it('rejects impossible state/count combinations', () => {
    const replay = { replaying: false, lastReplayAt: null, lastReplayRecordedRecords: 0, lastReplayFailed: false };
    for (const value of [{ state: 'ready', pendingRecords: null }, { state: 'missing', pendingRecords: 1 },
      { state: 'unavailable', pendingRecords: 0 }]) {
      expect(usageOutboxStatusSchema.safeParse({ ...replay, oldestPendingAt: null, ...value }).success).toBe(false);
    }
  });

  it('does not create storage on a read and verifies owner-only storage during initialization', async () => {
    expect(await usageOutboxStatus()).toMatchObject({ state: 'missing', pendingRecords: 0 });
    expect(await readdir(root)).toEqual([]);
    await initializeUsageOutbox();
    expect(await usageOutboxStatus()).toMatchObject({ state: 'ready', pendingRecords: 0, oldestPendingAt: null });
  });

  it('counts pending metadata without reading or returning any queued contents or filenames', async () => {
    await initializeUsageOutbox();
    const id = randomUUID();
    await writeFile(join(path, id + '.json'), 'PRIVATE_TOKEN_IN_INVALID_JSON', { mode: 0o600 });
    await writeFile(join(path, 'PRIVATE_OTHER_FILENAME.txt'), 'PRIVATE_OTHER_CONTENT', { mode: 0o600 });
    const status = await usageOutboxStatus();
    expect(status).toMatchObject({ state: 'ready', pendingRecords: 1, oldestPendingAt: expect.any(String) });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE_|usage-monitor|private-outbox/);
    expect(JSON.stringify(status)).not.toContain(id);
  });

  it('refuses publicly readable directories and reports unavailable metadata rather than paths', async () => {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o755);
    await expect(initializeUsageOutbox()).rejects.toThrow('private directory');
    expect(await usageOutboxStatus()).toMatchObject({ state: 'unavailable', pendingRecords: null });
  });

  it('refuses publicly readable queued files or symlinked records', async () => {
    await initializeUsageOutbox();
    const file = join(path, randomUUID() + '.json');
    await writeFile(file, 'PRIVATE_CONTENT', { mode: 0o600 });
    await chmod(file, 0o644);
    expect(await usageOutboxStatus()).toMatchObject({ state: 'unavailable', pendingRecords: null });
    await rm(file);
    const target = join(root, 'PRIVATE_TARGET');
    await writeFile(target, 'PRIVATE_CONTENT', { mode: 0o600 });
    await symlink(target, file);
    expect(await usageOutboxStatus()).toMatchObject({ state: 'unavailable', pendingRecords: null });
  });

  it('exposes safe replay failure status for invalid pending records without exposing their contents', async () => {
    await initializeUsageOutbox();
    await writeFile(join(path, randomUUID() + '.json'), 'PRIVATE_INVALID_JSON', { mode: 0o600 });
    stop = startUsageRecovery(1000);
    await stop(); stop = undefined;
    const status = await usageOutboxStatus();
    expect(status).toMatchObject({ state: 'ready', pendingRecords: 1, replaying: false,
      lastReplayFailed: true, lastReplayRecordedRecords: 0, lastReplayAt: expect.any(String) });
    expect(JSON.stringify(status)).not.toContain('PRIVATE_');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('PRIVATE_');
  });
});

it('keeps exhausted records visible as unrecorded usage after successful empty replay passes',async () => {
  await initializeUsageOutbox();
  await writeFile(join(path,randomUUID()+'.json.failed'),'PRIVATE_EXHAUSTED',{mode:0o600});
  stop=startUsageRecovery(1000); await stop(); stop=undefined;
  expect(await usageOutboxStatus()).toMatchObject({state:'ready',pendingRecords:1,lastReplayFailed:true,oldestPendingAt:expect.any(String)});
});
