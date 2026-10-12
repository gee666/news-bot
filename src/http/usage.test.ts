import express, { type ErrorRequestHandler } from 'express';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { usageRoutes } from './usage.js';
import type { UsageServices, UsageStats } from '../usage/contracts.js';

const totals = { calls: 0, completedCalls: 0, unknownUsageCalls: 0, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, estimatedCost: null, estimatedCostCalls: 0,
  actualBilledCost: null, actualBilledCostCalls: 0 };
const stats: UsageStats = { accountingStartedAt: '2026-01-01T00:00:00.000Z', historicalUsageAvailable: false,
  currency: 'USD', totals, series: [], seriesTruncated: false, groups: [],
  options: { models: [], providers: [], stages: [] } };
let services: UsageServices;
let server: Server;
let base: string;

beforeEach(async () => {
  services = { usage: vi.fn(async () => ({ ...stats, privatePrompt: 'PRIVATE_PROMPT' })),
    usageCalls: vi.fn(async () => ({ total: 0, limit: 50, offset: 0, calls: [], token: 'PRIVATE_TOKEN' })) };
  const app = express();
  usageRoutes(app, services);
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next;
    res.status(error instanceof z.ZodError ? 400 : 500).json({ error: 'Invalid request.' });
  };
  app.use(errors);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test address');
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('usage HTTP routes', () => {
  it('returns explicit historic and cost coverage with no private service fields', async () => {
    const response = await fetch(base + '/api/usage');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(stats);
    expect(services.usage).toHaveBeenCalledWith({ bucket: 'day' });
    const calls = await fetch(base + '/api/usage/calls');
    expect(await calls.json()).toEqual({ total: 0, calls: [], limit: 50, offset: 0 });
    expect(services.usageCalls).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  });

  it('passes exact filters and bounded pagination to services', async () => {
    const filters = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z',
      model: 'gpt-6-luna', provider: 'openai-codex', stage: 'research:queries:repair' };
    expect((await fetch(base + '/api/usage?' + new URLSearchParams({ ...filters, bucket: 'hour' }))).status).toBe(200);
    expect(services.usage).toHaveBeenCalledWith({ ...filters, bucket: 'hour' });
    expect((await fetch(base + '/api/usage/calls?' + new URLSearchParams({ ...filters, limit: '10', offset: '20' }))).status).toBe(200);
    expect(services.usageCalls).toHaveBeenCalledWith({ ...filters, limit: 10, offset: 20 });
  });

  it.each(['from=not-a-date', 'to=2026-02-30T00%3A00%3A00Z', 'bucket=month', 'model=', 'unknown=1',
    'from=2026-01-03T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z', 'model=x&model=y'])(
    'rejects invalid stats query %s before calling services', async query => {
    expect((await fetch(base + '/api/usage?' + query)).status).toBe(400);
    expect(services.usage).not.toHaveBeenCalled();
  });

  it.each(['limit=201', 'limit=0', 'limit=1.5', 'offset=-1', 'offset=1000001', 'offset=bad', 'bucket=day'])(
    'rejects invalid detail query %s before calling services', async query => {
    expect((await fetch(base + '/api/usage/calls?' + query)).status).toBe(400);
    expect(services.usageCalls).not.toHaveBeenCalled();
  });
});
