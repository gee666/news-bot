// @vitest-environment jsdom
import { act, createElement } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UsagePanel } from './UsagePanel';
import { testUsage, testUsageCalls } from './test-fixtures';
import { mount, element, click, input } from './test-dom';

function deferred() {
  let resolve: (response: Response) => void = () => { throw new Error('Promise not initialized'); };
  let reject: (error: Error) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<Response>((success, failure) => { resolve = success; reject = failure; });
  return { promise, resolve, reject };
}
type Flight = ReturnType<typeof deferred> & { url: string; signal: AbortSignal | undefined };
const response = (body: unknown) => new Response(JSON.stringify(body));
const views: Awaited<ReturnType<typeof mount>>[] = [];
const render = async () => { const view = await mount(createElement(UsagePanel, { active: true })); views.push(view); return view; };
const tick = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
const settle = async (flight: Flight, body: unknown) => { await act(async () => { flight.resolve(response(body)); }); };
const flightAt = (flights: Flight[], index: number) => {
  const flight = flights[index]; if (!flight) throw new Error(`Missing flight ${index}`); return flight;
};
const refreshButton = (container: Element) => {
  const button = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Refresh usage');
  if (!button) throw new Error('Missing refresh button'); return button;
};
function pending(flights: Flight[], url: string, options?: RequestInit) {
  const flight = { ...deferred(), url, signal: options?.signal ?? undefined };
  flights.push(flight);
  // Ignore abort here so tests also exercise the stale-response guard.
  return flight.promise;
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each(['summary', 'history'] as const)('accepts a 95-second %s request while the other endpoint renders and polls', async slow => {
  const flights: Flight[] = [];
  const isSlow = (url: string) => url.includes('/usage/calls?') === (slow === 'history');
  const fetch = vi.fn((url: string, options?: RequestInit) => isSlow(url) ? pending(flights, url, options) :
    Promise.resolve(response(slow === 'summary' ? testUsageCalls : testUsage)));
  vi.stubGlobal('fetch', fetch);
  const { container } = await render();
  expect(container.textContent).toContain(slow === 'summary' ? '1 to 25 of 26' : '2 of 3 calls report usage');
  await tick(95000);
  expect(fetch.mock.calls.filter(([url]) => isSlow(url))).toHaveLength(1);
  expect(fetch.mock.calls.filter(([url]) => !isSlow(url))).toHaveLength(4);
  expect(flightAt(flights, 0).signal?.aborted).toBe(false);
  await settle(flightAt(flights, 0), slow === 'summary' ? testUsage : testUsageCalls);
  expect(container.textContent).toContain('1 to 25 of 26');
  expect(container.textContent).toContain('2 of 3 calls report usage');
  await tick(29999);
  expect(flights).toHaveLength(1);
  await tick(1);
  expect(flights).toHaveLength(2);
});

it.each(['summary', 'history'] as const)('shows a %s failure without waiting for the other endpoint', async failed => {
  const flights: Flight[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => pending(flights, url, options)));
  const { container } = await render();
  const failedIndex = failed === 'summary' ? 0 : 1;
  const otherIndex = 1 - failedIndex;
  await act(async () => { flightAt(flights, failedIndex).reject(new Error('private provider detail')); });
  expect(container.querySelector('[role=alert]')?.textContent).toContain(failed === 'summary' ? 'Could not load usage totals' : 'Could not load model call history');
  expect(container.textContent).not.toContain('private provider detail');
  expect(flightAt(flights, otherIndex).signal?.aborted).toBe(false);
  await tick(95000);
  expect(flights).toHaveLength(3);
  await settle(flightAt(flights, otherIndex), failed === 'summary' ? testUsageCalls : testUsage);
  expect(container.textContent).toContain(failed === 'summary' ? '1 to 25 of 26' : '2 of 3 calls report usage');
});

it('skips manual refresh for a pending endpoint and never starts overlapping same-query requests', async () => {
  const flights: Flight[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => pending(flights, url, options)));
  const { container } = await render();
  await settle(flightAt(flights, 0), testUsage);
  const button = refreshButton(container);
  await act(async () => { button.click(); button.click(); });
  expect(flights).toHaveLength(3);
  expect(flightAt(flights, 2).url).not.toContain('/calls?');
  expect(flightAt(flights, 1).signal?.aborted).toBe(false);
  await tick(95000);
  expect(flights).toHaveLength(3);
  await settle(flightAt(flights, 1), testUsageCalls);
  expect(container.textContent).toContain('1 to 25 of 26');
  expect(container.textContent).toContain('Loading usage totals.');
});

it('does not cancel or restart pending requests when unchanged filters are reapplied', async () => {
  const flights: Flight[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => pending(flights, url, options)));
  const { container } = await render();
  const apply = [...container.querySelectorAll('button')].find(item => item.textContent === 'Apply filters');
  if (!apply) throw new Error('Missing Apply filters');
  await click(apply);
  await tick(95000);
  expect(flights).toHaveLength(2);
  expect(flightAt(flights, 0).signal?.aborted).toBe(false);
  expect(flightAt(flights, 1).signal?.aborted).toBe(false);
  await settle(flightAt(flights, 0), testUsage);
  expect(container.textContent).toContain('2 of 3 calls report usage');
});

it('changes only the call-history query on pagination, even while totals remain pending', async () => {
  const flights: Flight[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => pending(flights, url, options)));
  const { container } = await render();
  await settle(flightAt(flights, 1), testUsageCalls);
  const next = [...container.querySelectorAll('button')].find(item => item.textContent === 'Next');
  if (!next) throw new Error('Missing Next');
  expect(next.disabled).toBe(false);
  await click(next);
  expect(flights).toHaveLength(3);
  expect(flightAt(flights, 2).url).toContain('offset=25');
  expect(flightAt(flights, 0).signal?.aborted).toBe(false);
  await settle(flightAt(flights, 2), { ...testUsageCalls, offset: 25, calls: testUsageCalls.calls.slice(0, 1) });
  expect(container.textContent).toContain('26 to 26 of 26');
  expect(container.textContent).toContain('Loading usage totals.');
});

it('aborts changed filters and ignores late results and errors from superseded requests', async () => {
  const flights: Flight[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => pending(flights, url, options)));
  const { container } = await render();
  await settle(flightAt(flights, 0), testUsage);
  await click(refreshButton(container));
  await input(element(container, '#usage-model', HTMLSelectElement), 'test-pi');
  const apply = [...container.querySelectorAll('button')].find(item => item.textContent === 'Apply filters');
  if (!apply) throw new Error('Missing Apply filters');
  await click(apply);
  expect(flights).toHaveLength(5);
  expect(flightAt(flights, 1).signal?.aborted).toBe(true);
  expect(flightAt(flights, 2).signal?.aborted).toBe(true);
  expect(flightAt(flights, 3).url).toContain('model=test-pi');
  await settle(flightAt(flights, 3), { ...testUsage, totals: { ...testUsage.totals, inputTokens: 130, totalTokens: 180 } });
  await settle(flightAt(flights, 4), { ...testUsageCalls, total: 3, calls: testUsageCalls.calls.slice(0, 3) });
  await settle(flightAt(flights, 1), testUsageCalls);
  await act(async () => { flightAt(flights, 2).reject(new Error('stale private error')); });
  expect(container.querySelector('.metrics')?.textContent).toContain('180');
  expect(container.textContent).toContain('1 to 3 of 3');
  expect(container.textContent).not.toContain('1 to 25 of 26');
  expect(container.querySelector('[role=alert]')).toBeNull();
});

it('aborts on tab deactivation and unmount, stops timers and ignores late responses', async () => {
  const flights: Flight[] = [];
  vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => pending(flights, url, options)));
  const view = await render();
  await view.rerender(createElement(UsagePanel, { active: false }));
  expect(flightAt(flights, 0).signal?.aborted).toBe(true);
  expect(flightAt(flights, 1).signal?.aborted).toBe(true);
  await settle(flightAt(flights, 0), testUsage);
  await settle(flightAt(flights, 1), testUsageCalls);
  await tick(95000);
  expect(flights).toHaveLength(2);
  expect(view.container.textContent).not.toContain('2 of 3 calls report usage');
  await view.rerender(createElement(UsagePanel, { active: true }));
  expect(flights).toHaveLength(4);
  await view.unmount(); views.splice(views.indexOf(view), 1);
  expect(flightAt(flights, 2).signal?.aborted).toBe(true);
  expect(flightAt(flights, 3).signal?.aborted).toBe(true);
  await settle(flightAt(flights, 2), testUsage);
  await tick(95000);
  expect(flights).toHaveLength(4);
});
