import { beforeEach, expect, it, vi } from 'vitest';
import { eventInput, mentionInput } from './consolidation-input.js';
import { historicalEventInput } from './historical-input.js';
import { groupingState } from './grouping-input.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../db.js', () => ({ db: { query } }));
beforeEach(() => query.mockReset());
const row = { id: 'mention', revision_id: 'revision', text: 'Telegram outage worldwide',
  source_url: 'https://t.me/exploitex/37491', links: [], published_at: new Date('2026-10-26T21:00:00+02:00') };
const report = { text: row.text, sourceUrl: row.source_url, links: [], publishedAt: '2026-10-26T19:00:00.000Z' };

it.each([mentionInput, eventInput])('%s includes the source publication time in UTC and keeps unknown times null', async build => {
  query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ ...row, published_at: null }] });
  const known = await build('known');
  const unknown = await build('unknown');
  expect(known?.reports).toEqual([report]);
  expect(unknown?.reports).toEqual([{ ...report, publishedAt: null }]);
  expect(query.mock.calls[0]?.[0]).toContain('i.published_at');
  if (!known || !unknown) throw new Error('Missing fixture');
  expect(groupingState(known, unknown)).toEqual({
    incoming: { id: 'known', reports: [report] },
    candidate: { id: 'unknown', reports: [{ ...report, publishedAt: null }] },
  });
});

it('includes publication time in input fingerprints so time changes invalidate concurrency receipts', async () => {
  query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ ...row, published_at: new Date('2026-10-27T19:00:00Z') }] });
  const before = await eventInput('story');
  const after = await eventInput('story');
  expect(before?.fingerprint).not.toBe(after?.fingerprint);
});

it.each([row.published_at, null])('includes source publication time on historical reports: %s', async published_at => {
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...row, published_at }] });
  const input = await historicalEventInput('story', { revisionId: 'revision', batchId: 'batch', text: row.text });
  expect(input?.reports).toEqual([{ ...report, publishedAt: published_at?.toISOString() ?? null }]);
  expect(query.mock.calls[1]?.[0]).toContain('i.published_at');
});

it.each([row.published_at, null])('includes source publication time on historical extraction fallback: %s', async published_at => {
  query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ source_url: row.source_url, published_at }] });
  const input = await historicalEventInput('story', { revisionId: 'revision', batchId: 'batch', text: row.text });
  expect(input?.reports).toEqual([{ ...report, publishedAt: published_at?.toISOString() ?? null }]);
  expect(query.mock.calls[2]?.[0]).toContain('i.published_at');
});
