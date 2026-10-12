import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defaultSettings } from '../settings.js';
import { createApp, type ApiServices } from './app.js';
import type { Operation } from './operations.js';

const id = '946b26ea-14f9-473d-8a1f-6bf47b15b62a';
const secret = 'never-return-this-token-or-redirect-code';
const operation: Operation = { id, kind: 'test_pi', status: 'queued', attempt: 1,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', nextRetryAt: null, message: 'Queued.', failure: null };
let server: Server;
let base: string;
let csrf: string;
let services: ApiServices;
const headers = () => ({ Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' });
const write = (path: string, body: unknown, method = 'POST') => fetch(base + path, { method, headers: headers(), body: JSON.stringify(body) });

beforeEach(async () => {
  services = {
    usage: vi.fn(), usageCalls: vi.fn(),
    primarySources: vi.fn(async () => []),
    addPrimarySource: vi.fn(), editPrimarySource: vi.fn(), seedPrimarySources: vi.fn(async () => []),
    settings: vi.fn(async () => ({ ...defaultSettings, apiKey: secret })),
    save: vi.fn(async () => defaultSettings),
    sources: vi.fn(async () => [{ id, name: 'Disabled channel', externalId: '-1001', enabled: false, active: true, access: 'restricted', metadata: { session: secret } }]),
    toggleSource: vi.fn(async () => true),
    status: vi.fn(async () => ({ batches: [], waits: [], embeddings: [], publications: [], token: secret })),
    loginStatus: vi.fn(async () => ({ provider: 'openai-codex' as const, connected: true, login: null, accessToken: secret })),
    loginStart: vi.fn(async () => ({ provider: 'openai-codex' as const, connected: false, login: {
      id, phase: 'awaiting_redirect' as const, expiresAt: '2026-01-01T00:00:00.000Z', authorizationUrl: 'https://auth.openai.com/oauth/authorize',
      token: secret,
    } })),
    loginFinish: vi.fn(async () => { throw new Error(secret); }), loginCancel: vi.fn(async () => {}),
    start: vi.fn(async () => operation), operation: vi.fn(async () => operation), operations: vi.fn(async () => [operation]),
  };
  server = createApp(services, { webDirectory: 'tmp/no-web-build' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  base = `http://127.0.0.1:${(address satisfies AddressInfo).port}`;
  const response = await fetch(base + '/api/session');
  csrf = z.object({ csrfToken: z.string() }).parse(await response.json()).csrfToken;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
});

describe('private browser API', () => {
  it('starts a durable bounded run with defaults and a polling handle', async () => {
    const response = await write('/api/operations', { kind: 'run_now' });
    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe(`/api/operations/${id}`);
    expect(services.start).toHaveBeenCalledWith('run_now', { mode: 'collect', publicationLimit: 5, sourceLimit: 3, inputLimit: 20, storyLimit: 5 });
  });
  it('accepts collected-only limits without changing saved settings', async () => {
    const response = await write('/api/operations', { kind: 'run_now', options: { mode: 'collected', publicationLimit: 1, inputLimit: 2, sourceLimit: 1, storyLimit: 1 } });
    expect(response.status).toBe(202);
    expect(services.start).toHaveBeenCalledWith('run_now', { mode: 'collected', publicationLimit: 1, inputLimit: 2, sourceLimit: 1, storyLimit: 1 });
    expect(services.save).not.toHaveBeenCalled();
  });
  it.each([{ publicationLimit: 0 }, { publicationLimit: 11 }, { publicationLimit: 1.5 }, { inputLimit: 51 },
    { sourceLimit: 11 }, { storyLimit: 11 }, { mode: 'replay' }, { bypass: true }, { inputLimit: '2' }])(
    'rejects unsafe run options %j before dispatch', async options => {
      expect((await write('/api/operations', { kind: 'run_now', options })).status).toBe(400);
      expect(services.start).not.toHaveBeenCalled();
    });
  it('does not accept limits on unrelated operations or dispatch without CSRF', async () => {
    expect((await write('/api/operations', { kind: 'collection', options: { inputLimit: 1 } })).status).toBe(400);
    expect((await fetch(base + '/api/operations', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'run_now' }) })).status).toBe(403);
    expect(services.start).not.toHaveBeenCalled();
  });
  it('projects settings, source, status and OAuth responses without saved secrets', async () => {
    for (const path of ['/api/settings', '/api/sources', '/api/status', '/api/pi/login']) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain(secret);
    }
    const started = await write('/api/pi/login', {});
    expect(started.status).toBe(202);
    expect(await started.text()).not.toContain(secret);
  });
  it('exposes partial-batch counts and retained failed-stage audit context without private content', async () => {
    services.status = vi.fn(async () => ({
      batches: [{ id, status: 'completed', started_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:01:00.000Z',
        next_retry_at: null, waiting_reason: 'Some items were withheld.', error_code: 'partial_item_failure',
        item_counts: { total: 3, completed: 2, rejected: 0, failed: 1, pending: 0 }, raw_source: secret }],
      waits: [{ batch_id: id, batch_status: 'completed', batch_completed_at: '2026-01-01T00:01:00.000Z', batch_error_code: 'partial_item_failure',
        stage: 'extract', status: 'failed', next_retry_at: null, waiting_reason: null, error_code: 'invalid_output', count: 1,
        model_response: secret }], embeddings: [], publications: [],
    }));
    const response = await fetch(base + '/api/status');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"failed":1');
    expect(body).toContain('partial_item_failure');
    expect(body).toContain('"batch_status":"completed"');
    expect(body).not.toContain(secret);
  });
  it('returns read-only historical denial and recovery diagnostics without private material', async () => {
    const date = '2026-01-01T00:00:00.000Z';
    services.status = vi.fn(async () => ({ batches: [], waits: [], embeddings: [], publications: [],
      publicationAdmissionDenials: [{ publicationId: id, snapshotId: id, operation: null, reason: 'current_generation_missing',
        lastSeenAt: date, occurrences: 1, snapshot: { text: secret }, sourceUrl: secret, credentials: secret }],
      digestRecovery: { phase: 'waiting', failure_phase: 'story_refresh', code: 'invalid_output', next_retry_at: date, inputBoundary: secret },
      aggregateSelections: [{ key: 'source_link_deferred:hash', status: 'unresolved', phase: 'confirmation', story_id: id,
        left_id: null, right_id: null, updated_at: date, rawResponse: secret }],
      storyRecovery: [{ batch_id: id, stage_id: id, story_id: id, state: 'consumed', updated_at: date, rawText: secret }],
      siblingRecovery: [{ key: 'sibling_recovery:hash', state: 'consumed', original_batch_id: id, batch_id: null,
        story_budget: 2, dispatches: 1, updated_at: date, settings: secret }],
    }));
    const response = await fetch(base + '/api/status');
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('current_generation_missing'); expect(body).toContain('"occurrences":1');
    expect(body).toContain('"operation":null'); expect(body).toContain('"failure_phase":"story_refresh"');
    expect(body).not.toContain('"dispatches"'); expect(body).toContain('"status":"unresolved"');
    expect(body).not.toContain(secret);
    expect(services.start).not.toHaveBeenCalled(); expect(services.save).not.toHaveBeenCalled();
  });
  it('rejects foreign Host, Origin, cross-site requests and missing CSRF before touching state', async () => {
    for (const badHeaders of [
      { ...headers(), Host: 'attacker.example' },
      { ...headers(), Origin: 'https://attacker.example' },
      { ...headers(), 'Sec-Fetch-Site': 'cross-site' },
      { Origin: base, 'Content-Type': 'application/json' },
      { ...headers(), 'X-CSRF-Token': 'é'.repeat(64) },
    ]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(base + '/api/settings', { method: 'PUT', headers: badHeaders }, response => {
          response.resume();
          resolve(response.statusCode);
        });
        request.on('error', reject);
        request.end(JSON.stringify({ retentionDays: 20 }));
      });
      expect(status).toBe(403);
    }
    expect(services.save).not.toHaveBeenCalled();
    const response = await fetch(base + '/api/session', { headers: { Origin: 'null' } });
    expect(response.status).toBe(403);
  });
  it('permits safe document navigation while refusing cross-site API reads', async () => {
    const page = await fetch(base + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(page.status).toBe(503); // Test intentionally has no built UI.
    const session = await fetch(base + '/api/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    expect(session.status).toBe(403);
  });
  it.each([
    { retentionDays: 0 }, { minimumPublicationScore: 11 }, { researchThreshold: '7' },
    { jevUrl: 'http://user:password@localhost:8765' }, { embeddingUrl: 'file:///etc/passwd' },
    { collectionCron: 'not cron' }, { timezone: 'No/Such_Zone' }, { publishingEnabled: 'true' },
    { profileVersion: 99 }, { apiKey: secret }, { piModel: '' }, { retryMaxMs: 1000 },
  ])('validates settings patch %j without reflecting values', async patch => {
    const response = await write('/api/settings', patch, 'PUT');
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
    expect(services.save).not.toHaveBeenCalled();
  });
  it('accepts valid settings and source toggles, preserving disabled state in lists', async () => {
    expect((await write('/api/settings', { timezone: 'Etc/GMT-2', retentionDays: 14 }, 'PUT')).status).toBe(200);
    expect(services.save).toHaveBeenCalledWith({ timezone: 'Etc/GMT-2', retentionDays: 14 });
    expect((await write(`/api/sources/${id}`, { enabled: false }, 'PATCH')).status).toBe(200);
    expect(services.toggleSource).toHaveBeenCalledWith(id, false);
    expect((await write(`/api/sources/${id}`, { enabled: 'false' }, 'PATCH')).status).toBe(400);
  });
  it('returns operation handles immediately and validates action names', async () => {
    const response = await write('/api/operations', { kind: 'test_pi' });
    expect(response.status).toBe(202);
    expect(response.headers.get('location')).toBe(`/api/operations/${id}`);
    expect(await response.json()).toEqual(operation);
    expect((await write('/api/operations', { kind: 'send_arbitrary_message' })).status).toBe(400);
    expect((await fetch(base + '/api/operations/not-a-uuid')).status).toBe(400);
  });
  it('keeps callback URLs out of errors and console logs', async () => {
    const log = vi.spyOn(console, 'error');
    const redirectUrl = `http://localhost:1455/auth/callback?code=${secret}&state=state`;
    const response = await write('/api/pi/redirect', { id, redirectUrl });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(secret);
    expect(services.loginFinish).toHaveBeenCalledWith(id, redirectUrl);
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
  it('uses a generic response for backend exceptions', async () => {
    services.settings = vi.fn(async () => { throw new Error(secret); });
    const response = await fetch(base + '/api/settings');
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(secret);
  });
});
