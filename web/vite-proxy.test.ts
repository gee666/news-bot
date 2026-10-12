import { createServer as createViteServer } from 'vite';
import express from 'express';
import { resolve } from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import { expect, it } from 'vitest';
import viteConfig from '../vite.config';
import { browserSecurity } from '../src/http/security';
import { usageRoutes } from '../src/http/usage';
import { testUsage, testUsageCalls, testRuntime } from './test-fixtures';
import { runtimeRoutes } from '../src/http/runtime.js';
import { runtimeSchema } from './api';
import { usageSchema, usageCallsSchema } from './usage';

it('serves /api.ts locally, proxies /api/ and preserves origin, cookies and CSRF checks', async () => {
  const app = express();
  const security = browserSecurity();
  app.use(security.guard);
  app.use(express.json());
  let authorizedReads = 0;
  let writes = 0;
  const forwarded: IncomingHttpHeaders[] = [];
  app.get('/api/session', (req, res) => {
    forwarded.push({ ...req.headers });
    res.json({ csrfToken: security.token });
  });
  runtimeRoutes(app, { usageOutboxStatus: async () => ({ state: 'ready', pendingRecords: 0, oldestPendingAt: null,
    replaying: false, lastReplayAt: null, lastReplayRecordedRecords: 0, lastReplayFailed: false }) });
  usageRoutes(app, { usage: async () => { authorizedReads++; return testUsage; },
    usageCalls: async query => ({ ...testUsageCalls, calls: [], offset: query.offset, limit: query.limit }) });
  app.put('/api/settings', (_req, res) => { writes++; res.sendStatus(204); });
  app.use((_req, res) => res.status(404).end());
  const backend = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => backend.once('listening', resolve));
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
  try {
    const address = backend.address();
    if (!address || typeof address === 'string') throw new Error('Missing backend port');
    const proxy = { ...viteConfig.server?.proxy };
    expect(proxy).toEqual({ '^/api/': { target: 'http://127.0.0.1:3000', changeOrigin: false } });
    const apiProxy = proxy['^/api/'];
    if (!apiProxy || typeof apiProxy === 'string') throw new Error('Missing API proxy options');
    proxy['^/api/'] = { ...apiProxy, target: `http://127.0.0.1:${address.port}` };
    vite = await createViteServer({ ...viteConfig, configFile: false,
      cacheDir: resolve('tmp/frontend-vite-test-cache'), optimizeDeps: { noDiscovery: true, include: [] },
      server: { ...viteConfig.server, port: 0, proxy, watch: null } });
    await vite.listen();
    const frontend = vite.httpServer?.address();
    if (!frontend || typeof frontend === 'string') throw new Error('Missing frontend port');
    const base = `http://127.0.0.1:${frontend.port}`;
    const module = await fetch(base + '/api.ts');
    expect(module.status).toBe(200);
    expect(module.headers.get('content-type')).toContain('javascript');
    expect(await module.text()).toContain('csrfToken');
    const session = await fetch(base + '/api/session', { headers: { Origin: base,
      Authorization: 'Bearer fixture-only', Cookie: 'fixture=present' } });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ csrfToken: security.token });
    expect(forwarded).toMatchObject([{ host: `127.0.0.1:${frontend.port}`, origin: base,
      authorization: 'Bearer fixture-only', cookie: 'fixture=present' }]);
    const runtime = await fetch(base + '/api/runtime');
    expect(runtime.status).toBe(200);
    expect(runtimeSchema.parse(await runtime.json())).toEqual(testRuntime);
    const summary = await fetch(base + '/api/usage');
    expect(summary.status).toBe(200);
    expect(usageSchema.parse(await summary.json())).toEqual(testUsage);
    const history = await fetch(base + '/api/usage/calls?limit=25&offset=0');
    expect(history.status).toBe(200);
    expect(usageCallsSchema.parse(await history.json())).toMatchObject({ calls: [], limit: 25, offset: 0 });
    expect(authorizedReads).toBe(1);
    expect((await fetch(base + '/api/usage', { headers: { Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect((await fetch(base + '/api/usage', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    expect(authorizedReads).toBe(1);
    expect((await fetch(base + '/api/settings', { method: 'PUT', headers: { Origin: base } })).status).toBe(403);
    expect(writes).toBe(0);
    expect((await fetch(base + '/api/settings', { method: 'PUT', headers: { Origin: base, 'X-CSRF-Token': security.token } })).status).toBe(204);
    expect(writes).toBe(1);
  } finally {
    await vite?.close();
    backend.closeAllConnections();
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }
});
