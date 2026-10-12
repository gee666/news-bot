// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourcePanel } from './SourcePanel';
import { emptySourceDraft, primarySourceSchema, sourceInput } from './primary-sources';
import { mount, element, click, input } from './test-dom';

const id = '11111111-1111-4111-8111-111111111111';
const cleanups: (() => Promise<void>)[] = [];
const action = async (work: () => Promise<void>) => { await work(); };
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllGlobals(); });
async function render(sources: Parameters<typeof SourcePanel>[0]['sources'] = []) {
  const refresh = vi.fn();
  const view = await mount(createElement(SourcePanel, { sources, loadError: '', busy: false, action, refresh }));
  cleanups.push(view.unmount);
  return { container: view.container, refresh };
}
function button(container: Element, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(control => control.textContent === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error('missing_button');
  return found;
}

it('displays bounded backlog diagnostics and preserves configured settings through an unrelated edit', async () => {
  const source = primarySourceSchema.parse({ ...sourceInput(emptySourceDraft), id, name: 'Configured', publisher: 'Publisher',
    url: 'https://example.org/feed', configState: 'valid', identityLocked: true,
    maxArticles: 40, backlogLimit: 500, retryDelayMinutes: 180, feedDateRole: 'submission',
    cursor: { cutoff: '2026-10-01T12:00:00.000Z', attemptedIds: ['blocked'], unknownIds: ['collected'],
      skippedUnknownIds: ['skipped'], backlogOverflow: 8,
      backlog: [{ id: 'blocked', url: 'https://example.org/hidden-backlog-url', title: 'hidden-backlog-title',
        publishedAt: null, discoveredAt: '2026-10-01T12:00:00.000Z', failures: 2,
        nextAttemptAt: '2026-10-01T15:00:00.000Z', lastErrorCode: 'primary_article_restricted_http_403' }] } });
  if (source.configState !== 'valid') throw new Error('invalid_fixture');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ...source, name: 'Renamed' })));
  vi.stubGlobal('fetch', fetch);
  const { container, refresh } = await render([source]);
  expect(container.textContent).toContain('40 article attempts per cutoff');
  expect(container.textContent).toContain('Saved backlog: 1/500 entries');
  expect(container.textContent).toContain('1 unresolved reads');
  expect(container.textContent).toContain('1 legacy IDs');
  expect(container.textContent).toContain('Overflow drops: 8');
  expect(container.textContent).toContain('primary_article_restricted_http_403');
  expect(container.textContent).toContain('Earliest retry cutoff');
  expect(container.textContent).not.toMatch(/hidden-backlog|Last completed cutoff/u);
  await click(element(container, '[aria-label="Edit Configured"]', HTMLButtonElement));
  expect(fetch).not.toHaveBeenCalled();
  expect(element(container, '#source-max-articles', HTMLInputElement).value).toBe('40');
  expect(element(container, '#source-max-articles', HTMLInputElement).max).toBe('50');
  expect(element(container, '#source-backlog-limit', HTMLInputElement).value).toBe('500');
  expect(element(container, '#source-retry-delay', HTMLInputElement).value).toBe('180');
  expect(element(container, '#source-feed-date-role', HTMLSelectElement).value).toBe('submission');
  await input(element(container, 'form input[maxlength="200"]', HTMLInputElement), 'Renamed');
  await click(button(container, 'Save source'));
  const request = fetch.mock.calls[0];
  expect(request?.[0]).toBe('/api/primary-sources/'+id);
  expect(request?.[1]?.method).toBe('PATCH');
  const saved: unknown = JSON.parse(String(request?.[1]?.body));
  expect(saved).toEqual({ ...sourceInput(emptySourceDraft), name: 'Renamed', publisher: 'Publisher',
    url: source.url, maxArticles: 40, backlogLimit: 500, retryDelayMinutes: 180, feedDateRole: 'submission' });
  expect(saved).not.toHaveProperty('cursor');
  expect(saved).not.toHaveProperty('collectionCron');
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('explicitly clears submission semantics in a PATCH when an uncollected feed changes to a website', async () => {
  const source = primarySourceSchema.parse({ ...sourceInput(emptySourceDraft), id, name: 'Uncollected', publisher: 'Publisher',
    url: 'https://example.org/feed', configState: 'valid', identityLocked: false,
    maxArticles: 19, backlogLimit: 300, retryDelayMinutes: 80, feedDateRole: 'submission', articleLinkPolicy: 'external', cursor: {} });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ...source,
    kind: 'website', articleLinkPolicy: 'same_host', feedDateRole: 'publication' })));
  vi.stubGlobal('fetch', fetch);
  const { container } = await render([source]);
  await click(element(container, '[aria-label="Edit Uncollected"]', HTMLButtonElement));
  await input(element(container, 'form select', HTMLSelectElement), 'website');
  await click(button(container, 'Save source'));
  expect(fetch.mock.calls[0]?.[1]?.method).toBe('PATCH');
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ kind: 'website',
    articleLinkPolicy: 'same_host', feedDateRole: 'publication', maxArticles: 19, backlogLimit: 300, retryDelayMinutes: 80 });
});

it('opens conservative default controls without changing saved sources or making a request', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { container } = await render();
  await click(button(container, 'Add source'));
  expect(element(container, '#source-max-articles', HTMLInputElement).value).toBe('3');
  expect(element(container, '#source-backlog-limit', HTMLInputElement).value).toBe('');
  expect(element(container, '#source-retry-delay', HTMLInputElement).value).toBe('');
  expect(element(container, '#source-feed-date-role', HTMLSelectElement).value).toBe('publication');
  expect(fetch).not.toHaveBeenCalled();
});

it('HN preset is an unsaved new draft and changing it to a website removes feed-only permissions', async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    const draft: unknown = JSON.parse(String(options?.body));
    const config = primarySourceSchema.parse({ ...sourceInput(emptySourceDraft),
      ...(typeof draft === 'object' && draft !== null ? draft : {}), id,
      configState: 'valid', identityLocked: false, cursor: {} });
    return new Response(JSON.stringify(config));
  });
  vi.stubGlobal('fetch', fetch);
  const { container } = await render();
  await click(button(container, 'Add Hacker News preset'));
  expect(fetch).not.toHaveBeenCalled();
  expect(element(container, '#source-max-articles', HTMLInputElement).value).toBe('20');
  expect(element(container, '#source-feed-date-role', HTMLSelectElement).value).toBe('submission');
  await input(element(container, 'form select', HTMLSelectElement), 'website');
  expect(element(container, '#source-feed-date-role', HTMLSelectElement).disabled).toBe(true);
  expect(element(container, '#source-feed-date-role', HTMLSelectElement).value).toBe('publication');
  await click(button(container, 'Save source'));
  const saved: unknown = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
  expect(saved).toMatchObject({ kind: 'website', articleLinkPolicy: 'same_host', feedDateRole: 'publication', maxArticles: 20,
    backlogLimit: 200, retryDelayMinutes: 60 });
  expect(saved).not.toHaveProperty('collectionCron');
});
