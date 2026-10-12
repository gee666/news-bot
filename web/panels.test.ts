// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourcePanel } from './SourcePanel';
import { TelegramSources } from './TelegramSources';
import { StatusPanel } from './StatusPanel';
import { LoginPanel } from './LoginPanel';
import { primarySourceSchema } from './primary-sources';
import { operationSchema } from './api';
import { mount, element, click, input } from './test-dom';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (node: Parameters<typeof mount>[0]) => { const view = await mount(node); cleanups.push(view.unmount); return view.container; };
const id = '11111111-1111-4111-8111-111111111111';
const action = async (work: () => Promise<void>) => { await work(); };

it('starts the small run with editable limits and collected-only mode', async () => {
  const run = vi.fn();
  const container = await render(createElement(StatusPanel, { status: null, operations: [], run, busy: false }));
  expect(element(container, '#run-now-publicationLimit', HTMLInputElement).value).toBe('5');
  await input(element(container, '#run-now-publicationLimit', HTMLInputElement), '1');
  await input(element(container, '#run-now-mode', HTMLSelectElement), 'collected');
  await click(element(container, '.run-now button', HTMLButtonElement));
  expect(run).toHaveBeenCalledWith('run_now', { mode: 'collected', publicationLimit: 1, inputLimit: 20, sourceLimit: 3, storyLimit: 5 });
  expect(container.textContent).toContain('Omitted entries stay available');
});

it('disables duplicate manual runs and displays stage counts, withheld reasons and the final result', async () => {
  const operation = operationSchema.parse({ id, kind: 'run_now', status: 'waiting', attempt: 1,
    createdAt: '2026-10-02T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', nextRetryAt: '2026-10-02T10:05:00.000Z',
    message: 'Telegram delivery is waiting.', failure: null, runNow: { stage: 'publishing', options: {}, inputs: 4, stories: 2, published: 1,
      updated: 1, reasons: { unchanged_failure_or_release_hold: 1 } } });
  const run = vi.fn();
  const container = await render(createElement(StatusPanel, { status: null, operations: [operation], run, busy: false }));
  expect(element(container, '.run-now button', HTMLButtonElement).disabled).toBe(true);
  expect(element(container, '#run-now-inputLimit', HTMLInputElement).matches(':disabled')).toBe(true);
  expect(container.textContent).toContain('Stage: publishing');
  expect(container.textContent).toContain('4 new revisions');
  expect(container.textContent).toContain('1 new posts');
  expect(container.textContent).toContain('1 existing posts updated');
  expect(container.textContent).toContain('unchanged failure or release hold: 1');
  await click(element(container, '.run-now button', HTMLButtonElement)); expect(run).not.toHaveBeenCalled();
});

it('filters Telegram sources by name or channel ID without changing enablement', async () => {
  const container = await render(createElement(TelegramSources, { sources: [
    { id, name: 'AI news', externalId: '-100123', access: 'public', enabled: true, active: true },
    { id: '22222222-2222-4222-8222-222222222222', name: 'Hardware', externalId: '-100456', access: 'public', enabled: false, active: false },
  ], loadError: '', busy: false, refreshing: false, run: vi.fn(), action, refresh: vi.fn() }));
  await input(element(container, '#channel-search', HTMLInputElement), '456');
  expect(container.querySelector('.sources')?.textContent).toContain('Hardware');
  expect(container.querySelector('.sources')?.textContent).not.toContain('AI news');
  expect(element(container, '.sources input', HTMLInputElement).checked).toBe(false);
  await input(element(container, '#channel-search', HTMLInputElement), 'no-match');
  expect(container.textContent).toContain('No channels match');
});

it('filters primary sources and locks collected identities when editing', async () => {
  const source = primarySourceSchema.parse({ id, name: 'Publisher feed', publisher: 'Publisher', kind: 'feed', url: 'https://example.com/news/',
    enabled: true, configState: 'valid', identityLocked: true, articlePathPrefixes: ['/news/'], maxArticles: 3, unknownPublication: 'skip', cursor: {} });
  const container = await render(createElement(SourcePanel, { sources: [source], loadError: '', busy: false, action, refresh: vi.fn() }));
  await input(element(container, '#source-kind', HTMLSelectElement), 'website');
  expect(container.textContent).toContain('No sources match');
  await input(element(container, '#source-kind', HTMLSelectElement), 'all');
  await click(element(container, '[aria-label="Edit Publisher feed"]', HTMLButtonElement));
  expect(element(container, 'form select', HTMLSelectElement).disabled).toBe(true);
  expect(element(container, 'form input[type=url]', HTMLInputElement).disabled).toBe(true);
  expect(container.textContent).toContain('Kind and URL cannot change');
});

it('filters operations without losing audit labels or failure details', async () => {
  const base = { id, kind: 'collection', status: 'completed_with_errors', attempt: 1, createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z', nextRetryAt: null, message: 'One story was withheld.', failure: null };
  const operations = [operationSchema.parse(base), operationSchema.parse({ ...base, id: '22222222-2222-4222-8222-222222222222', kind: 'test_pi', status: 'failed', message: 'Test failed.' })];
  const container = await render(createElement(StatusPanel, { status: null, operations, run: vi.fn(), busy: false }));
  expect(container.textContent).toContain('Recorded failed attempt');
  await input(element(container, '#operation-status', HTMLSelectElement), 'completed_with_errors');
  expect(container.querySelector('.operations')?.textContent).toContain('One story was withheld');
  expect(container.querySelector('.operations')?.textContent).not.toContain('Test failed');
  await input(element(container, '#operation-kind', HTMLSelectElement), 'test_pi');
  expect(container.textContent).toContain('No operations match');
});

it('keeps a pasted OAuth redirect available when completion fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Redirect expired' }), { status: 400 })));
  const failures: string[] = [];
  const container = await render(createElement(LoginPanel, { login: { provider: 'openai-codex', connected: false,
    login: { id, phase: 'awaiting_redirect', expiresAt: '2099-01-01T00:00:00.000Z' } }, busy: false, loadError: '', setLogin: vi.fn(), refresh: vi.fn(),
    action: async work => { try { await work(); } catch (error) { if (error instanceof Error) failures.push(error.message); } } }));
  const control = element(container, '#redirect-url', HTMLInputElement);
  await input(control, 'http://localhost/callback?code=fixture&state=test');
  await click(element(container, 'form button', HTMLButtonElement));
  expect(failures).toEqual(['Redirect expired']);
  expect(control.value).toBe('http://localhost/callback?code=fixture&state=test');
});
