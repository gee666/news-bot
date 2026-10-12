import { once } from 'node:events';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defaultSettings } from '../settings.js';
import { addPrimarySource, editPrimarySource, listPrimarySources, seedPrimarySources } from '../sources/index.js';
import { createApp, type ApiServices } from './app.js';
import { publicPrimarySourceSchema } from './primary-sources.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), lookup: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query: mocks.query },
  transaction: (run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }) }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
const id = '11111111-1111-4111-8111-111111111111';
const secret = 'PRIVATE-source-body-auth-key';
const cursor = { cutoff: '2026-01-01T00:00:00.000Z', completedIds: ['article-1'], unknownIds: ['undated-1'],
  seen: [], unseenBatches: 0, rechecked: false, attemptedIds: [], backlog: [], backlogOverflow: 0,
  skippedUnknownIds: [], unknownPolicy: null };
const input = { kind: 'feed', name: 'Publisher', publisher: 'Publisher', url: 'https://example.org/feed',
  articleLinkPolicy: 'same_host', articlePathPrefixes: ['/news/'], maxArticles: 2, unknownPublication: 'collect_once', enabled: true };
const row = { id, connector_type: 'feed', name: input.name, original_url: input.url, enabled: true,
  metadata: { publisher: input.publisher, articlePathPrefixes: input.articlePathPrefixes,
    maxArticles: input.maxArticles, unknownPublication: input.unknownPublication, authKey: secret },
  collection_cursor: cursor, body: secret };
let server: Server;
let base: string;
let csrf: string;
let services: ApiServices;
const headers = () => ({ Origin: base, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' });
const write = (path: string, body: unknown, method = 'POST') =>
  fetch(base + path, { method, headers: headers(), body: JSON.stringify(body) });

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  mocks.query.mockReset();
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('AS has_items') ? [{ has_items: false }] : [row] }));
  services = {
    usage: vi.fn(), usageCalls: vi.fn(),
    primarySources: listPrimarySources, addPrimarySource: vi.fn(addPrimarySource),
    editPrimarySource: vi.fn(editPrimarySource), seedPrimarySources: vi.fn(seedPrimarySources),
    settings: async () => defaultSettings, save: async () => defaultSettings, sources: async () => [],
    toggleSource: vi.fn(), status: vi.fn(), loginStatus: vi.fn(), loginStart: vi.fn(), loginFinish: vi.fn(),
    loginCancel: vi.fn(), start: vi.fn(), operation: vi.fn(), operations: vi.fn(),
  };
  server = createApp(services, { webDirectory: 'tmp/no-web-build' }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  base = `http://127.0.0.1:${address.port}`;
  csrf = z.object({ csrfToken: z.string() }).parse(await (await fetch(base + '/api/session')).json()).csrfToken;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

it('lists configuration and cursor but no contents, keys or extra metadata', async () => {
  const response = await fetch(base + '/api/primary-sources');
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(secret);
  expect(JSON.parse(body)).toEqual([{ ...input, id, cursor, configState: 'valid', identityLocked: false }]);
  expect(services.seedPrimarySources).not.toHaveBeenCalled();
});

it.each([
  ['/api/primary-sources', 'POST'],
  [`/api/primary-sources/${id}`, 'PATCH'],
  ['/api/primary-sources/seed', 'POST'],
])('protects %s mutations before repository access', async (path, method) => {
  for (const badHeaders of [
    { ...headers(), Origin: 'https://foreign.example' },
    { Origin: base, 'Content-Type': 'application/json' },
  ]) {
    const response = await fetch(base + path, { method, headers: badHeaders, body: JSON.stringify(input) });
    expect(response.status).toBe(403);
  }
  expect(mocks.query).not.toHaveBeenCalled();
  expect(services.addPrimarySource).not.toHaveBeenCalled();
  expect(services.editPrimarySource).not.toHaveBeenCalled();
  expect(services.seedPrimarySources).not.toHaveBeenCalled();
});

it.each([
  ['/api/primary-sources', 'POST', { ...input, authKey: secret }],
  [`/api/primary-sources/${id}`, 'PATCH', { enabled: false, body: secret }],
  ['/api/primary-sources/seed', 'POST', { auto: true }],
  ['/api/primary-sources/not-a-uuid', 'PATCH', { enabled: false }],
])('rejects invalid DTO for %s without writes or reflected values', async (path, method, body) => {
  const response = await write(path, body, method);
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain(secret);
  expect(mocks.query).not.toHaveBeenCalled();
});

it.each(['http://127.0.0.1/feed', 'https://user:PRIVATE-source-body-auth-key@example.org/feed',
  'http://localhost/feed', 'https://example.org:8080/feed'])('rejects private/credential URL %s at repository', async url => {
  const response = await write('/api/primary-sources', { ...input, url });
  expect(response.status).toBe(400);
  expect(await response.text()).not.toContain(secret);
  expect(services.addPrimarySource).toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});

it('rejects private and mixed DNS for add, edit and explicit seed without writes', async () => {
  mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  expect((await write('/api/primary-sources', input)).status).toBe(400);
  expect((await write(`/api/primary-sources/${id}`, { enabled: false }, 'PATCH')).status).toBe(400);
  expect((await write('/api/primary-sources/seed', {})).status).toBe(400);
  expect(mocks.query.mock.calls.every(call => String(call[0]).startsWith('SELECT'))).toBe(true);
});

it('adds with defaults, saves edits, then toggles without resetting other fields or cursor', async () => {
  const { maxArticles: _max, unknownPublication: _unknown, enabled: _enabled, articleLinkPolicy: _policy, ...required } = input;
  void _max; void _unknown; void _enabled; void _policy;
  expect((await write('/api/primary-sources', required)).status).toBe(201);
  expect(services.addPrimarySource).toHaveBeenCalledWith({ ...required, maxArticles: 3, unknownPublication: 'skip', enabled: true,
    articleLinkPolicy: 'same_host' });
  mocks.query.mockClear();
  const renamed = { ...row, name: 'Renamed' };
  mocks.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ has_items: false }] })
    .mockResolvedValueOnce({ rows: [renamed] });
  const saved = await write(`/api/primary-sources/${id}`, { name: 'Renamed' }, 'PATCH');
  expect(saved.status).toBe(200);
  expect(publicPrimarySourceSchema.parse(await saved.json())).toEqual({ ...input, name: 'Renamed', id, cursor, configState: 'valid', identityLocked: false });
  mocks.query.mockResolvedValueOnce({ rows: [renamed] }).mockResolvedValueOnce({ rows: [{ has_items: false }] })
    .mockResolvedValueOnce({ rows: [{ ...renamed, enabled: false }] });
  const toggled = await write(`/api/primary-sources/${id}`, { enabled: false }, 'PATCH');
  expect(toggled.status).toBe(200);
  expect(publicPrimarySourceSchema.parse(await toggled.json())).toEqual({ ...input, name: 'Renamed', enabled: false, id, cursor, configState: 'valid', identityLocked: false });
  const values = mocks.query.mock.calls[5]?.[1];
  expect(values?.[3]).toBe('Renamed');
  expect(values?.[4]).toBe(false);
  expect(JSON.parse(values?.[5] ?? '{}')).toEqual({
    publisher: input.publisher, articlePathPrefixes: input.articlePathPrefixes,
    maxArticles: 2, unknownPublication: 'collect_once', articleLinkPolicy: 'same_host',
  });
  expect(values?.[6]).toBe(false);
});

it('supports a narrow aggregator policy PATCH and exposes persisted policy in the view', async () => {
  const hn = { ...row, name: 'Hacker News', original_url: 'https://hnrss.org/newest' };
  const opted = { ...hn, metadata: { ...hn.metadata, articleLinkPolicy: 'external', articlePathPrefixes: ['/'] } };
  mocks.query.mockResolvedValueOnce({ rows: [hn] }).mockResolvedValueOnce({ rows: [{ has_items: false }] })
    .mockResolvedValueOnce({ rows: [opted] });
  const patch = { articleLinkPolicy: 'external', articlePathPrefixes: ['/'] };
  const response = await write(`/api/primary-sources/${id}`, patch, 'PATCH');
  expect(response.status).toBe(200);
  expect(services.editPrimarySource).toHaveBeenCalledWith(id, patch);
  expect(publicPrimarySourceSchema.parse(await response.json())).toMatchObject({
    id, url: 'https://hnrss.org/newest', articleLinkPolicy: 'external', articlePathPrefixes: ['/'],
  });
  const values = mocks.query.mock.calls[2]?.[1];
  expect(values?.[0]).toBe(id);
  expect(JSON.parse(values?.[5] ?? '{}')).toMatchObject(patch);
  expect(values?.[6]).toBe(false);
});

it('returns reliability options and safe progress and preserves configured budgets on an unrelated PATCH', async () => {
  const settings = { maxArticles: 40, backlogLimit: 800, retryDelayMinutes: 120, feedDateRole: 'submission' };
  const progress = { ...cursor, attemptedIds: ['blocked'], backlogOverflow: 6,
    backlog: [{ id: 'blocked', url: 'https://example.org/news/blocked', title: null, publishedAt: null,
      discoveredAt: '2026-01-01T00:00:00.000Z', failures: 1, nextAttemptAt: '2026-01-01T02:00:00.000Z',
      lastErrorCode: 'primary_article_restricted_http_403' }] };
  const configured = { ...row, metadata: { ...row.metadata, ...settings }, collection_cursor: progress };
  mocks.query.mockResolvedValueOnce({ rows: [configured] });
  expect(await (await fetch(base + '/api/primary-sources')).json()).toEqual([
    { ...input, ...settings, id, cursor: progress, configState: 'valid', identityLocked: false },
  ]);
  mocks.query.mockResolvedValueOnce({ rows: [configured] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [{ ...configured, name: 'Renamed' }] });
  const response = await write(`/api/primary-sources/${id}`, { name: 'Renamed' }, 'PATCH');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...input, ...settings, name: 'Renamed', id, cursor: progress,
    configState: 'valid', identityLocked: true });
  const update = mocks.query.mock.calls.find(call => String(call[0]).startsWith('UPDATE sources'));
  expect(JSON.parse(update?.[1]?.[5] ?? '{}')).toMatchObject(settings);
  expect(update?.[1]?.[6]).toBe(false);
  expect(mocks.query.mock.calls.some(call => /UPDATE settings|UPDATE app_settings/u.test(String(call[0])))).toBe(false);
});

it.each([{ maxArticles: 51 }, { backlogLimit: 1001 }, { retryDelayMinutes: 0 }, { feedDateRole: 'unknown' },
  { collectionCron: '* * * * *' }])('rejects invalid reliability option %j without writes', async patch => {
  expect((await write(`/api/primary-sources/${id}`, patch, 'PATCH')).status).toBe(400);
  expect(mocks.query).not.toHaveBeenCalled();
});

it('seeds only on explicit request and uses conflict-safe inserts on repeated requests', async () => {
  for (let count = 0; count < 2; count++) {
    const response = await write('/api/primary-sources/seed', {});
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secret);
  }
  const inserts = mocks.query.mock.calls.filter(call => String(call[0]).includes('INSERT'));
  expect(inserts).toHaveLength(10);
  expect(inserts.every(call => String(call[0]).includes('DO NOTHING'))).toBe(true);
});

it('lists malformed sources individually with safe identity only', async () => {
  const invalidId = '22222222-2222-4222-8222-222222222222';
  mocks.query.mockResolvedValue({ rows: [row, { ...row, id: invalidId,
    original_url: `https://user:${secret}@example.org/feed`, metadata: { token: secret }, identity_locked: true }] });
  const response = await fetch(base + '/api/primary-sources');
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(secret);
  expect(JSON.parse(body)).toEqual([
    { ...input, id, cursor, configState: 'valid', identityLocked: false },
    { id: invalidId, kind: 'feed', name: input.name, url: null, enabled: true,
      identityLocked: true, configState: 'invalid', errorCode: 'primary_source_invalid_config' },
  ]);
});

it('disables malformed configuration without resolving URL or requiring missing fields', async () => {
  const invalid = { ...row, original_url: null, metadata: { secret } };
  mocks.query.mockResolvedValueOnce({ rows: [invalid] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [{ ...invalid, enabled: false }] });
  const response = await write(`/api/primary-sources/${id}`, { enabled: false }, 'PATCH');
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(secret);
  expect(JSON.parse(body)).toEqual({ id, kind: 'feed', name: input.name, url: null, enabled: false,
    identityLocked: true, configState: 'invalid', errorCode: 'primary_source_invalid_config' });
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls[2]?.[0]).toContain('SET enabled=false');
});

it.each([{ enabled: true }, { enabled: false, name: 'Repair' }, { url: input.url }])(
  'rejects invalid-config edits other than disable %j', async patch => {
    mocks.query.mockResolvedValue({ rows: [{ ...row, metadata: { secret } }] });
    const response = await write(`/api/primary-sources/${id}`, patch, 'PATCH');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 'primary_source_invalid_config',
      error: 'Source needs configuration. Only disabling is allowed. Add a replacement source and preserve the old history.' });
    expect(mocks.query.mock.calls.every(call => String(call[0]).startsWith('SELECT'))).toBe(true);
    expect(mocks.lookup).not.toHaveBeenCalled();
  },
);

it.each([{ kind: 'website' }, { url: 'https://example.org/other-feed' }, { url: input.url + '/' }])(
  'requires replacement for ingested source identity edits %j', async patch => {
    mocks.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ has_items: true }] });
    const response = await write(`/api/primary-sources/${id}`, patch, 'PATCH');
    expect(response.status).toBe(409);
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(JSON.parse(body)).toEqual({ code: 'replace_source_required',
      error: 'This source has collection history. Add a replacement source to change kind or URL. Disable the old source to preserve its history.' });
    expect(mocks.query.mock.calls.every(call => String(call[0]).startsWith('SELECT'))).toBe(true);
  },
);

it('allows non-identity edits and disabling locked valid sources without reading malformed neighbors', async () => {
  const renamed = { ...row, name: 'Renamed', enabled: false };
  mocks.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ has_items: true }] })
    .mockResolvedValueOnce({ rows: [renamed] });
  const response = await write(`/api/primary-sources/${id}`, { name: 'Renamed', enabled: false }, 'PATCH');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ...input, name: 'Renamed', enabled: false, id, cursor,
    configState: 'valid', identityLocked: true });
  expect(mocks.query.mock.calls[0]?.[0]).toContain('WHERE id=$1');
  expect(mocks.query.mock.calls[0]?.[1]).toEqual([id]);
  expect(mocks.query.mock.calls[2]?.[1]?.[6]).toBe(false);
  expect(JSON.parse(mocks.query.mock.calls[2]?.[1]?.[5] ?? '{}')).toMatchObject({ publisherIdentityLocked: true });
});

it('returns a sanitized missing-source response', async () => {
  mocks.query.mockResolvedValue({ rows: [] });
  const response = await write(`/api/primary-sources/${id}`, { enabled: false }, 'PATCH');
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Source not found.' });
});
