import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageOutboxStatus } from './models/usage-outbox-status.js';

const mocks = vi.hoisted(() => ({
  migrate: vi.fn(async () => {}), end: vi.fn(async () => {}), settings: vi.fn(async () => ({})),
  runtime: vi.fn(async () => ({})), initializeOutbox: vi.fn(async () => {}),
  retryInterval: vi.fn(() => 30_000), stopUsage: vi.fn(async () => {}), recoverUsage: vi.fn(),
  resume: vi.fn(async () => {}), stopOperations: vi.fn(async () => {}), cancelOAuth: vi.fn(async () => {}),
  startPipeline: vi.fn(async () => {}), stopPipeline: vi.fn(async () => {}),
  startBot: vi.fn(), stopBot: vi.fn(async () => {}), status: vi.fn(),
}));
vi.mock('./db.js', () => ({ db: { end: mocks.end }, migrate: mocks.migrate }));
vi.mock('./settings.js', () => ({ getSettings: mocks.settings }));
vi.mock('./models/index.js', () => ({ openPiRuntime: mocks.runtime }));
vi.mock('./models/usage-delivery.js', () => ({ initializeUsageOutbox: mocks.initializeOutbox,
  startUsageRecovery: mocks.recoverUsage, usageRecoveryInterval: mocks.retryInterval }));
vi.mock('./models/usage-outbox-status.js', () => ({ usageOutboxStatus: mocks.status }));
vi.mock('./pipeline/index.js', () => ({ createPipeline: vi.fn(async () => ({
  start: mocks.startPipeline, stop: mocks.stopPipeline,
})) }));
vi.mock('./publishing/index.js', () => ({ startPublicationMaintenance: mocks.startBot }));
vi.mock('./http/services.js', () => ({ createServices: vi.fn(() => ({ services: {},
  operations: { resume: mocks.resume, stop: mocks.stopOperations }, oauth: { cancel: mocks.cancelOAuth },
})) }));
const listeners: Server[] = [];
vi.mock('./http/app.js', () => ({ createApp: vi.fn(() => ({
  listen: (_port: number, _host: string, ready: () => void) => {
    const server = createServer((_req, res) => { res.end('Read access'); });
    listeners.push(server);
    server.listen(0, '127.0.0.1', ready);
    return server;
  },
})) }));
import { startServer } from './server.js';
import { createApp } from './http/app.js';

const readyOutbox: UsageOutboxStatus = { state: 'ready', pendingRecords: 0, oldestPendingAt: null,
  replaying: false, lastReplayAt: null, lastReplayRecordedRecords: 0, lastReplayFailed: false };
let stop: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('PORT', '3000'); vi.stubEnv('HOST', '127.0.0.1');
  mocks.status.mockResolvedValue(readyOutbox);
  mocks.recoverUsage.mockReturnValue(mocks.stopUsage);
  mocks.startBot.mockResolvedValue(mocks.stopBot);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(async () => {
  await stop?.(); stop = undefined;
  for (const server of listeners.splice(0)) {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('server startup', () => {
  it('preserves ordinary recovery/scheduler/maintenance startup when explicitly unheld', async () => {
    stop = await startServer();
    expect(mocks.resume).toHaveBeenCalledOnce();
    expect(mocks.startPipeline).toHaveBeenCalledOnce();
    expect(mocks.startBot).toHaveBeenCalledOnce();
    await stop(); stop = undefined;
    expect(mocks.stopBot).toHaveBeenCalledOnce();
  });

  it('degrades health when a worker fails startup instead of falsely reporting a healthy API',async()=>{
    mocks.startPipeline.mockRejectedValueOnce(new Error('PRIVATE_STARTUP_ERROR'));
    const error=vi.spyOn(console,'error').mockImplementation(()=>{});
    stop=await startServer();
    await vi.waitFor(()=>expect(vi.mocked(createApp).mock.calls[0]?.[1]?.backgroundHealthy?.()).toBe(false));
    expect(error).toHaveBeenCalledWith('Processing service failed to start; health is degraded. Check saved processing status.');
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE_STARTUP_ERROR');
  });

  it('refuses startup before listening or starting workers when usage storage is not private/ready', async () => {
    mocks.status.mockResolvedValue({ ...readyOutbox, state: 'unavailable', pendingRecords: null, oldestPendingAt: null });
    await expect(startServer()).rejects.toThrow('Model usage storage is not private and ready');
    expect(listeners).toHaveLength(0);
    expect(mocks.recoverUsage).not.toHaveBeenCalled();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.startPipeline).not.toHaveBeenCalled();
    expect(mocks.startBot).not.toHaveBeenCalled();
  });
});
