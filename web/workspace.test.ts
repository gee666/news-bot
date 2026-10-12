// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Tabs, type Tab } from './Tabs';
import { SettingsForm } from './SettingsForm';
import { UsagePanel } from './UsagePanel';
import { testSettings, testUsage, testUsageCalls, testRuntime } from './test-fixtures';
import { mount, element, click, input } from './test-dom';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = async (node: Parameters<typeof mount>[0]) => { const view = await mount(node); cleanups.push(view.unmount); return view.container; };
const buttonByText = (container: Element, text: string) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent === text);
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
};
function mockApi() {
  return vi.fn(async (url: string, options?: RequestInit) => {
    let body: unknown;
    if (url === '/api/session') body = { csrfToken: 'csrf-for-test' };
    else if (url === '/api/runtime') body = testRuntime;
    else if (url === '/api/settings') body = options?.method === 'PUT' && typeof options.body === 'string' ? JSON.parse(options.body) : testSettings;
    else if (url === '/api/pi/login') body = { provider: 'openai-codex', connected: true, login: null };
    else if (url === '/api/status') body = { batches: [], waits: [], embeddings: [], publications: [] };
    else if (url.startsWith('/api/usage/calls?')) body = { ...testUsageCalls, offset: Number(new URL(url, 'http://test').searchParams.get('offset')) };
    else if (url.startsWith('/api/usage?')) body = testUsage;
    else body = [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('workspace', () => {
  it('supports keyboard tab navigation, wrapping and home/end', async () => {
    const selected: Tab[] = [];
    const container = await render(createElement(Tabs, { selected: 'activity', select: tab => selected.push(tab) }));
    const activity = element(container, '#tab-activity', HTMLButtonElement);
    expect(activity.tabIndex).toBe(0);
    await act(async () => { activity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); });
    expect(selected.at(-1)).toBe('connections');
    expect(document.activeElement?.id).toBe('tab-connections');
    await act(async () => { activity.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); });
    expect(selected.at(-1)).toBe('connections');
    await act(async () => { activity.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(selected.at(-1)).toBe('activity');
  });
  it('shows exact saved research values, limits and unchanged interest text', async () => {
    const change = vi.fn();
    const container = await render(createElement(SettingsForm, { settings: { ...testSettings, researchThreshold: 7 }, change,
      test: vi.fn(), testDisabled: false, group: 'settings' }));
    const threshold = element(container, '#researchThreshold', HTMLInputElement);
    expect(threshold.value).toBe('7');
    expect(threshold.min).toBe('1'); expect(threshold.max).toBe('10');
    const searches = element(container, '#researchMaxSearches', HTMLInputElement);
    expect(searches.min).toBe('0'); expect(searches.max).toBe('10');
    expect(container.textContent).toContain('score at or above');
    expect(element(container, '#interestProfile', HTMLTextAreaElement).value).toBe(testSettings.interestProfile);
    await input(searches, '0');
    expect(change).toHaveBeenCalledWith('researchMaxSearches', 0);
  });
  it('keeps edits across tabs, saves with CSRF, and does not change the interest profile', async () => {
    const fetch = mockApi(); vi.stubGlobal('fetch', fetch);
    const container = await render(createElement(App));
    await click(element(container, '#tab-settings', HTMLButtonElement));
    await input(element(container, '#researchThreshold', HTMLInputElement), '6');
    await click(element(container, '#tab-connections', HTMLButtonElement));
    expect(element(container, '#panel-settings', HTMLDivElement).hidden).toBe(true);
    expect(buttonByText(container, 'Test Pi connection').disabled).toBe(true);
    await click(element(container, '#tab-settings', HTMLButtonElement));
    expect(element(container, '#researchThreshold', HTMLInputElement).value).toBe('6');
    const panel = element(container, '#panel-settings', HTMLDivElement);
    await click(buttonByText(panel, 'Save settings'));
    const save = fetch.mock.calls.find(([url, init]) => url === '/api/settings' && init?.method === 'PUT');
    expect(save?.[1]?.headers).toEqual(expect.objectContaining({ 'X-CSRF-Token': 'csrf-for-test' }));
    expect(JSON.parse(String(save?.[1]?.body))).toMatchObject({ researchThreshold: 6, interestProfile: testSettings.interestProfile });
    expect(container.textContent).toContain('Settings saved.');
  });
  it('opens advanced settings when a hidden field fails native validation', async () => {
    const fetch = mockApi(); vi.stubGlobal('fetch', fetch);
    const container = await render(createElement(App));
    await click(element(container, '#tab-settings', HTMLButtonElement));
    await input(element(container, '#retryBaseMs', HTMLInputElement), '0');
    const panel = element(container, '#panel-settings', HTMLDivElement);
    await click(buttonByText(panel, 'Save settings'));
    expect(element(panel, 'details', HTMLDetailsElement).open).toBe(true);
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/settings' && init?.method === 'PUT')).toBe(false);
  });
  it('explains scheduled publishing, Berlin collection times, delivery maintenance and the publishing pause', async () => {
    vi.stubGlobal('fetch', mockApi());
    const container = await render(createElement(App));
    await click(element(container, '#tab-settings', HTMLButtonElement));
    const panel = element(container, '#panel-settings', HTMLDivElement);
    expect(panel.textContent).toContain('05:00, 09:00, 13:00, 17:00 and 21:00');
    expect(panel.textContent).toContain('Europe/Berlin');
    expect(panel.textContent).toContain('wait for digest selection after story refresh');
    expect(panel.textContent).toContain('0 */3 * * *, every three hours');
    expect(panel.textContent).toContain('only to resume previously authorized delivery');
    expect(panel.textContent).toContain('Digest publishing cron');
    expect(panel.textContent).toContain('Enable publishing');
    expect(panel.textContent).toContain('Disable publishing to pause new sends and edits');
  });
  it('confirms manual publishing and sends nothing when cancelled', async () => {
    const fetch = mockApi(); vi.stubGlobal('fetch', fetch);
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const container = await render(createElement(App));
    await click(buttonByText(container, 'Refresh & publish digest now'));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('without waiting for the schedule'));
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/operations' && init?.method === 'POST')).toBe(false);
  });
});

describe('usage dashboard', () => {
  it('loads only when active, applies exact filters and paginates calls', async () => {
    const fetch = mockApi(); vi.stubGlobal('fetch', fetch);
    await render(createElement(UsagePanel, { active: false }));
    expect(fetch).not.toHaveBeenCalled();
    const container = await render(createElement(UsagePanel, { active: true }));
    expect(container.textContent).toContain('2 of 3 calls report usage');
    expect(container.textContent).toContain('1 of 3 calls have estimates');
    expect(container.textContent).toContain('Unavailable');
    await input(element(container, '#usage-model', HTMLSelectElement), 'test-pi');
    expect(fetch.mock.calls.filter(([url]) => url.includes('model=')).length).toBe(0);
    await click(buttonByText(container, 'Apply filters'));
    expect(fetch.mock.calls.some(([url]) => url.includes('/usage?') && url.includes('model=test-pi'))).toBe(true);
    await click(buttonByText(container, 'Next'));
    expect(fetch.mock.calls.some(([url]) => url.includes('/usage/calls?') && url.includes('offset=25') && !url.includes('bucket='))).toBe(true);
    await click(buttonByText(container, 'Reset filters'));
    expect(element(container, '#usage-model', HTMLSelectElement).value).toBe('');
    expect(container.textContent).toContain('1 to 25 of 26');
  });
  it('uses reported totals with exclusive cache categories and separates partial estimates from bills', async () => {
    const mixed = { ...testUsage, seriesTruncated: true, totals: { ...testUsage.totals,
      calls: 2, completedCalls: 2, unknownUsageCalls: 0,
      inputTokens: 80, outputTokens: 24, cacheReadTokens: 32, cacheWriteTokens: 1, totalTokens: 137,
      estimatedCost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0, total: 0.5 },
      estimatedCostCalls: 1, actualBilledCost: 0.12, actualBilledCostCalls: 1 } };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/usage/calls?') ?
      { total: 0, calls: [], limit: 25, offset: 0 } : mixed))));
    const container = await render(createElement(UsagePanel, { active: true }));
    expect([...container.querySelectorAll('.metric > strong')].map(node => node.textContent)).toEqual(['2', '137', '$0.50', '$0.12']);
    expect(container.textContent).toContain('Input excludes cache read and cache write tokens');
    expect(container.textContent).toContain('Uncached input');
    expect(container.textContent).toContain('1 of 2 calls have estimates');
    expect(container.textContent).toContain('1 of 2 calls report billed cost');
    expect(container.textContent).toContain('Earlier usage is unavailable');
    expect(container.textContent).toContain('not lifetime usage');
    expect(container.textContent).toContain('model groups still cover the full applied range');
    const notice = element(container, '.inline-note', HTMLParagraphElement);
    const metrics = element(container, '.metrics', HTMLDivElement);
    expect(notice.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('shows all-unknown usage as unavailable without treating missing billed costs as free', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/usage/calls?') ?
      { total: 0, calls: [], limit: 25, offset: 0 } : { ...testUsage, totals: { ...testUsage.totals,
        unknownUsageCalls: 3, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 } }))));
    const container = await render(createElement(UsagePanel, { active: true }));
    expect([...container.querySelectorAll('.metric > strong')].map(node => node.textContent)).toEqual(['3', 'Unavailable', '$0.0031', 'Unavailable']);
    expect(container.textContent).toContain('0 of 3 calls report usage');
    expect(container.textContent).toContain('Missing cost information does not mean free usage');
  });
  it('loads totals independently of failed call history and hides provider details', async () => {
    const normal = mockApi();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/usage/calls?') ? Promise.reject(new Error('secret provider body')) : normal(url)));
    const container = await render(createElement(UsagePanel, { active: true }));
    expect(container.textContent).toContain('Could not load model call history');
    expect(container.textContent).toContain('2 of 3 calls report usage');
    expect(container.textContent).not.toContain('secret');
  });
  it('retains valid totals after a refresh fails schema validation', async () => {
    const fetch = mockApi(); vi.stubGlobal('fetch', fetch);
    const container = await render(createElement(UsagePanel, { active: true }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...testUsage, currency: 'not-USD' })));
    await click(buttonByText(container, 'Refresh usage'));
    expect(container.textContent).toContain('Could not load usage totals');
    expect(container.textContent).toContain('2 of 3 calls report usage');
    expect(container.textContent).not.toContain('not-USD');
  });
  it('rejects reversed dates without requesting or applying them', async () => {
    const fetch = mockApi(); vi.stubGlobal('fetch', fetch);
    const container = await render(createElement(UsagePanel, { active: true }));
    await input(element(container, '#usage-from', HTMLInputElement), '2026-10-03T10:00');
    await input(element(container, '#usage-to', HTMLInputElement), '2026-10-02T10:00');
    const previous = fetch.mock.calls.length;
    await click(buttonByText(container, 'Apply filters'));
    expect(fetch.mock.calls.length).toBe(previous);
    expect(container.textContent).toContain('Filters were not applied');
  });
});
