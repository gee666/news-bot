// @vitest-environment jsdom
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { StatusPanel } from './StatusPanel';
import { statusSchema } from './api';
import { mount, element, click } from './test-dom';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const date = '2026-10-08T10:00:00.000Z';
const base = { batches: [], waits: [], embeddings: [], publications: [] };
const views: Awaited<ReturnType<typeof mount>>[] = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function renderStatus(value: unknown) {
  const run = vi.fn();
  const view = await mount(createElement(StatusPanel, { status: statusSchema.parse(value), operations: [], run, busy: false }));
  views.push(view);
  return { container: view.container, run };
}
it('shows incomplete source coverage, historical denials and recovery progress without new replay or delivery actions', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const { container, run } = await renderStatus({ ...base,
    batches: [{ id, status: 'completed', started_at: date, completed_at: date, next_retry_at: null,
      waiting_reason: null, error_code: null, item_counts: { total: 1, completed: 1, rejected: 0, failed: 0, pending: 0 },
      source_counts: { total: 2, completed: 1, failed: 1, pending: 0 },
      source_failures: [{ sourceId: otherId, code: 'publisher_article_failed', url: 'SECRET' }] }],
    digestRecovery: { phase: 'waiting', failure_phase: 'source_links', code: 'invalid_output', next_retry_at: date },
    aggregateSelections: [
      { key: 'consolidation_deferred:pair', status: 'unresolved', phase: null, story_id: null, left_id: id, right_id: otherId, updated_at: date },
      { key: 'source_link_deferred:link', status: 'unresolved', phase: 'confirmation', story_id: id, left_id: null, right_id: null, updated_at: date },
      { key: 'consolidation_deferred:old', status: 'resolved', phase: null, story_id: null, left_id: id, right_id: otherId, updated_at: date },
    ],
    publicationAdmissionDenials: [
      { publicationId: id, snapshotId: otherId, operation: 'edit', reason: 'source_quality_changed', lastSeenAt: date, occurrences: 3, snapshot: 'SECRET' },
      { publicationId: otherId, snapshotId: id, operation: null, reason: 'publishing_paused', lastSeenAt: date, occurrences: 1 },
    ],
  });
  expect(container.querySelector('.metrics')?.textContent).toContain('Incomplete source coverage');
  expect(container.querySelector('.record-heading .badge.warning')).not.toBeNull();
  expect(container.textContent).toContain('Sources: 2 total · 1 completed · 1 failed · 0 pending');
  expect(container.querySelector('.source-failures')?.textContent).toContain(`Source ${otherId} · publisher_article_failed`);
  const diagnostics = element(container, '.reliability-diagnostics', HTMLDivElement);
  expect(diagnostics.textContent).toContain('Historical observations, not necessarily active blocks');
  expect(diagnostics.textContent).toContain('source quality changed');
  expect(diagnostics.textContent).toContain('Operation: edit · Observations: 3');
  expect(diagnostics.textContent).toContain('Operation: not recorded · Observations: 1');
  expect(diagnostics.textContent).toContain(`Publication ${id}`); expect(diagnostics.textContent).toContain(`Snapshot ${otherId}`);
  expect(diagnostics.textContent).toContain('Recorded phase: waiting'); expect(diagnostics.textContent).toContain('Failure phase: source links');
  expect(diagnostics.textContent).toContain('invalid_output'); expect(diagnostics.textContent).toContain('Recorded retry');
  expect(diagnostics.textContent).toContain('2 unresolved records'); expect(diagnostics.textContent).toContain('Source link confirmation');
  expect(diagnostics.textContent).toContain(`Left story ${id}`); expect(diagnostics.textContent).toContain(`Right story ${otherId}`);
  expect(diagnostics.querySelector('time')?.getAttribute('dateTime')).toBe(date);
  expect(diagnostics.querySelectorAll('button, input, select, a[href]')).toHaveLength(0);
  await click(element(diagnostics, 'details summary', HTMLElement));
  expect(run).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('SECRET');
});
it('renders explicit empty diagnostic sections without inventing active blocks', async () => {
  const { container } = await renderStatus({ ...base, digestRecovery: null,
    aggregateSelections: [], publicationAdmissionDenials: [] });
  expect(container.textContent).toContain('No recorded admission denials');
  expect(container.textContent).toContain('No recorded digest recovery state');
  expect(container.textContent).toContain('No unresolved selection records');
});
it('keeps older status responses readable when optional diagnostics are absent', async () => {
  const { container } = await renderStatus(base);
  expect(container.textContent).toContain('No collection batches have been recorded');
  expect(container.querySelector('#admission-denials-heading')).toBeNull();
  expect(container.querySelector('#digest-recovery-heading')).toBeNull();
  expect(container.querySelector('#scoped-recovery-heading')).toBeNull();
});
