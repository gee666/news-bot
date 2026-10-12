import express, { type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { z } from 'zod';
import { publicSettings, settingsSchema, type AppSettings } from '../settings.js';
import type { OAuthStatus } from '../models/index.js';
import { operationKind, type Operation, type OperationKind } from './operations.js';
import { browserSecurity } from './security.js';
import { usageRoutes } from './usage.js';
import type { UsageServices } from '../usage/contracts.js';
import { primarySourceRoutes, type PrimarySourceServices } from './primary-sources.js';
import { publicLoginSchema, publicSourceSchema, publicStatusSchema } from './contracts.js';
import { runtimeRoutes, type RuntimeReadOptions } from './runtime.js';
import { runNowOptionsSchema, type RunNowOptions } from '../pipeline/run-now-contract.js';

export interface PublicSource {
  id: string; name: string; externalId: string; access: string; enabled: boolean; active: boolean;
}
export interface ApiServices extends PrimarySourceServices, UsageServices {
  settings(): Promise<AppSettings>;
  save(input: unknown): Promise<AppSettings>;
  sources(): Promise<PublicSource[]>;
  toggleSource(id: string, enabled: boolean): Promise<boolean>;
  status(): Promise<unknown>;
  loginStatus(): Promise<OAuthStatus>;
  loginStart(): Promise<OAuthStatus>;
  loginFinish(id: string, redirectUrl: string): Promise<OAuthStatus>;
  loginCancel(id: string): Promise<void>;
  start(kind: OperationKind, options?: RunNowOptions): Promise<Operation>;
  operation(id: string): Promise<Operation | null>;
  operations(): Promise<Operation[]>;
}

const writable = settingsSchema.omit({ profileVersion: true, modelVersion: true }).partial();
const idSchema = z.uuid();
const toggleSchema = z.object({ enabled: z.boolean() }).strict();
const loginFinishSchema = z.object({ id: idSchema, redirectUrl: z.string().min(1).max(8192) }).strict();
const loginCancelSchema = z.object({ id: idSchema }).strict();

export function createApp(services: ApiServices, options: RuntimeReadOptions & { allowedHosts?: readonly string[]; webDirectory?: string } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const security = browserSecurity(options.allowedHosts);
  app.use(security.guard);
  runtimeRoutes(app, options);
  app.use(express.json({ limit: '48kb', strict: true }));
  app.get('/api/session', (_req, res) => { res.json({ csrfToken: security.token }); });
  app.get('/api/settings', async (_req, res) => { res.json(publicSettings(await services.settings())); });
  app.put('/api/settings', async (req, res) => {
    const patch = writable.parse(req.body);
    const next = settingsSchema.parse({ ...publicSettings(await services.settings()), ...patch });
    if (next.retryMaxMs < next.retryBaseMs) {
      res.status(400).json({ error: 'Maximum retry delay must be at least the base delay.' }); return;
    }
    res.json(publicSettings(await services.save(patch)));
  });
  app.get('/api/sources', async (_req, res) => { res.json(z.array(publicSourceSchema).parse(await services.sources())); });
  app.patch('/api/sources/:id', async (req, res) => {
    const id = idSchema.parse(req.params.id);
    const { enabled } = toggleSchema.parse(req.body);
    if (!await services.toggleSource(id, enabled)) { res.status(404).json({ error: 'Source not found.' }); return; }
    res.json({ id, enabled });
  });
  primarySourceRoutes(app, services);
  usageRoutes(app, services);
  app.get('/api/status', async (_req, res) => { res.json(publicStatusSchema.parse(await services.status())); });
  app.get('/api/operations', async (_req, res) => { res.json(await services.operations()); });
  app.get('/api/operations/:id', async (req, res) => {
    const operation = await services.operation(idSchema.parse(req.params.id));
    if (!operation) { res.status(404).json({ error: 'Operation not found.' }); return; }
    res.json(operation);
  });
  app.post('/api/operations', async (req, res) => {
    const input = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('run_now'), options: runNowOptionsSchema.optional() }).strict(),
      z.object({ kind: operationKind.exclude(['run_now']) }).strict(),
    ]).parse(req.body);
    const operation = input.kind === 'run_now' ? await services.start(input.kind, runNowOptionsSchema.parse(input.options ?? {}))
      : await services.start(input.kind);
    res.status(202).location(`/api/operations/${operation.id}`).json(operation);
  });
  app.get('/api/pi/login', async (_req, res) => { res.json(publicLoginSchema.parse(await services.loginStatus())); });
  app.post('/api/pi/login', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.status(202).json(publicLoginSchema.parse(await services.loginStart()));
  });
  app.post('/api/pi/redirect', async (req, res) => {
    const { id, redirectUrl } = loginFinishSchema.parse(req.body);
    try { res.status(202).json(publicLoginSchema.parse(await services.loginFinish(id, redirectUrl))); }
    catch { res.status(400).json({ error: 'Login redirect was not accepted. Restart login and paste the complete redirect URL.' }); }
  });
  app.post('/api/pi/cancel', async (req, res) => {
    const { id } = loginCancelSchema.parse(req.body);
    await services.loginCancel(id);
    res.status(204).end();
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  const webDirectory = options.webDirectory ?? resolve('dist/web');
  app.use(express.static(webDirectory, { index: 'index.html', redirect: false }));
  app.get('/', (_req, res) => { res.status(503).type('text').send('Settings UI is not built. Run npm run build.'); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next;
    // Do not return validation input, callback URLs, provider errors, credentials or stacks.
    const invalid = error instanceof z.ZodError || (error instanceof SyntaxError && 'body' in error);
    const tooLarge = error instanceof Error && 'type' in error && error.type === 'entity.too.large';
    res.status(tooLarge ? 413 : invalid ? 400 : 500).json({ error: tooLarge ? 'Request is too large.' :
      invalid ? 'Invalid request. Check field types, ranges, endpoints, schedules and timezone.' : 'Request failed. Check server configuration and service availability.' });
  };
  app.use(errors);
  return app;
}
