// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './App';
import { runtimeSchema, type RuntimeStatus } from './api';
import { runtimeAccess } from './runtime';
import { testRuntime, testSettings, testUsage, testUsageCalls } from './test-fixtures';
import { mount } from './test-dom';

const held: RuntimeStatus = { automaticWorkEnabled: false, manualMutationsAllowed: false };
const id = '11111111-1111-4111-8111-111111111111';
const views: Awaited<ReturnType<typeof mount>>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
const render = async () => { const view = await mount(createElement(App)); views.push(view); return view.container; };
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); };
const button = (container: Element, text: string) => {
  const found = [...container.querySelectorAll('button')].find(node => node.textContent === text);
  if (!found) throw new Error(`Missing ${text}`); return found;
};
function mockApi(initial: RuntimeStatus = held, publishingEnabled = false) {
  let runtime: unknown = initial;
  let sessionVersion = 0;
  let pendingRuntime: Promise<Response> | null = null;
  const fetch = vi.fn(async (url: string, options?: RequestInit): Promise<Response> => {
    let body: unknown;
    if (url === '/api/runtime') {
      if (pendingRuntime) return pendingRuntime;
      if (runtime instanceof Error) throw runtime;
      body = runtime;
    } else if (url === '/api/session') body = { csrfToken: `session-${sessionVersion}` };
    else if (url === '/api/settings') {
      if (options?.method === 'PUT' && new Headers(options.headers).get('X-CSRF-Token') !== `session-${sessionVersion}`) throw new Error('Stale session token');
      body = options?.method === 'PUT' && typeof options.body === 'string' ? JSON.parse(options.body) : { ...testSettings, publishingEnabled };
    }
    else if (url === '/api/sources') body = [{ id, name: 'AI channel', externalId: '-100123', access: 'public', enabled: true, active: true }];
    else if (url === '/api/primary-sources') body = [{ id, name: 'Publisher', publisher: 'Publisher', kind: 'feed', url: 'https://example.com/news/',
      enabled: true, configState: 'valid', identityLocked: false, articlePathPrefixes: ['/news/'], maxArticles: 3, unknownPublication: 'skip', cursor: {} }];
    else if (url === '/api/pi/login') body = { provider: 'openai-codex', connected: false,
      login: { id, phase: 'awaiting_redirect', expiresAt: '2099-01-01T00:00:00.000Z', authorizationUrl: 'https://example.com/authorize' } };
    else if (url === '/api/status') body = { batches: [], waits: [], embeddings: [], publications: [] };
    else if (url === '/api/operations') body = [];
    else if (url.startsWith('/api/usage/calls?')) body = testUsageCalls;
    else if (url.startsWith('/api/usage?')) body = testUsage;
    else throw new Error(`Unexpected fixture request ${options?.method ?? 'GET'} ${url}`);
    return new Response(JSON.stringify(body));
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, setRuntime(next: unknown) { runtime = next; pendingRuntime = null; sessionVersion++; },
    setPending(next: Promise<Response>) { pendingRuntime = next; } };
}
it('parses the current runtime flags, ignores unused outbox metadata, and rejects invalid permissions', () => {
  expect(runtimeSchema.parse({ ...held, usageOutbox: { state: 'ready', pendingRecords: 0 } })).toEqual(held);
  expect(runtimeSchema.safeParse({ ...held, manualMutationsAllowed: 'true' }).success).toBe(false);
  expect(runtimeSchema.safeParse({ automaticWorkEnabled: true }).success).toBe(false);
  expect(runtimeAccess(held, '').mutationsBlocked).toBe(true);
  expect(runtimeAccess(null, '').mutationsBlocked).toBe(true);
  expect(runtimeAccess(testRuntime, 'unavailable').mutationsBlocked).toBe(true);
  expect(runtimeAccess({ ...testRuntime, manualMutationsAllowed: false }, '').mutationsBlocked).toBe(true);
  const paused = runtimeAccess({ ...testRuntime, automaticWorkEnabled: false }, '');
  expect(paused.mutationsBlocked).toBe(false);
  expect(paused.message).toContain('still allows manual actions');
});

it('fails closed before runtime loads or after verification fails, then recovers without reloading', async () => {
  const api = mockApi();
  let release: (value: Response) => void = () => { throw new Error('Not initialized'); };
  api.setPending(new Promise<Response>(resolve => { release = resolve; }));
  const container = await render();
  expect(container.querySelector('.runtime-notice')?.textContent).toContain('Checking runtime status');
  expect(button(container, 'Collect and process now').disabled).toBe(true);
  await act(async () => { release(new Response(JSON.stringify(testRuntime))); });
  expect(button(container, 'Collect and process now').disabled).toBe(false);
  api.setRuntime(new Error('private failure body'));
  await tick();
  expect(container.querySelector('.runtime-notice')?.textContent).toContain('Runtime status unavailable');
  expect(container.textContent).not.toContain('private failure body');
  expect(button(container, 'Collect and process now').disabled).toBe(true);
  api.setRuntime(testRuntime);
  await tick();
  expect(container.querySelector('.runtime-notice')).toBeNull();
  expect(button(container, 'Collect and process now').disabled).toBe(false);
});
