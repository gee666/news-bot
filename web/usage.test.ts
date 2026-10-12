import { describe, expect, it } from 'vitest';
import { usageSchema, usageCallsSchema, usageQuery, emptyUsageFilters, formatCount, formatCost, formatKnownTokens } from './usage';
import { testUsage, testUsageCalls, testSettings } from './test-fixtures';
import { settingsSchema } from './api';
import { usageStatsSchema, callsPageSchema } from '../src/usage/contracts.js';

describe('usage contract', () => {
  it('keeps fixtures compatible with current backend types and exclusive token categories', () => {
    expect(usageStatsSchema.parse(testUsage)).toEqual(testUsage);
    expect(callsPageSchema.parse(testUsageCalls)).toEqual(testUsageCalls);
    const totals = testUsage.totals;
    expect(totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens).toBe(totals.totalTokens);
  });
  it('validates partial cost and token coverage without replacing nulls with zero', () => {
    expect(usageSchema.parse(testUsage).totals.actualBilledCost).toBeNull();
    expect(usageCallsSchema.parse(testUsageCalls).calls[0]?.totalTokens).toBeNull();
    expect(formatCount(null)).toBe('Unavailable');
    expect(formatCost(null)).toBe('Unavailable');
    expect(formatCount(0)).toBe('0');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.0001)).toBe('$0.0001');
  });
  it('distinguishes unreported token sums from an empty recorded period', () => {
    expect(formatKnownTokens(0, { calls: 2, unknownUsageCalls: 2 })).toBe('Unavailable');
    expect(formatKnownTokens(0, { calls: 0, unknownUsageCalls: 0 })).toBe('0');
    expect(formatKnownTokens(120, { calls: 3, unknownUsageCalls: 1 })).toBe('120');
  });
  it('rejects malformed or negative accounting values', () => {
    expect(usageSchema.safeParse({ ...testUsage, totals: { ...testUsage.totals, calls: -1 } }).success).toBe(false);
    expect(usageSchema.safeParse({ ...testUsage, currency: 'EUR' }).success).toBe(false);
    expect(usageCallsSchema.safeParse({ ...testUsageCalls, calls: [{ ...testUsageCalls.calls[0], outcome: 'cached' }] }).success).toBe(false);
  });
  it('encodes exact filters and separates bucket queries from paginated calls', () => {
    const filters = { ...emptyUsageFilters, from: '2026-10-01T00:00Z', to: '2026-10-02T00:00Z', model: 'model/a & b', stage: 'research' };
    const summary = new URLSearchParams(usageQuery(filters));
    expect(summary.get('from')).toBe('2026-10-01T00:00:00.000Z');
    expect(summary.get('to')).toBe('2026-10-02T00:00:00.000Z');
    expect(summary.get('model')).toBe('model/a & b');
    expect(summary.get('bucket')).toBe('day');
    const calls = new URLSearchParams(usageQuery(filters, 25));
    expect(calls.has('bucket')).toBe(false);
    expect(calls.get('limit')).toBe('25');
    expect(calls.get('offset')).toBe('25');
    expect(new URLSearchParams(usageQuery(emptyUsageFilters)).has('from')).toBe(false);
  });
  it('rejects invalid and inverted date ranges before requesting data', () => {
    expect(() => usageQuery({ ...emptyUsageFilters, from: 'bad-date' })).toThrow('valid start');
    expect(() => usageQuery({ ...emptyUsageFilters, from: '2026-10-02', to: '2026-10-01' })).toThrow('later');
    expect(() => usageQuery({ ...emptyUsageFilters, from: '2026-10-02', to: '2026-10-02' })).toThrow('later');
  });
});

it('validates research settings with inclusive threshold range and zero searches', () => {
  expect(settingsSchema.parse({ ...testSettings, researchThreshold: 5, researchMaxSearches: 0 }).researchMaxSearches).toBe(0);
  for (const invalid of [{ researchThreshold: 0 }, { researchThreshold: 11 }, { researchThreshold: 5.5 },
    { researchMaxSearches: -1 }, { researchMaxSearches: 11 }, { researchMaxSearches: NaN }]) {
    expect(settingsSchema.safeParse({ ...testSettings, ...invalid }).success).toBe(false);
  }
});
