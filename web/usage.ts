import { z } from 'zod';

const count = z.number().int().nonnegative();
const cost = z.number().finite().nonnegative();
const costSchema = z.object({ input: cost, output: cost, cacheRead: cost, cacheWrite: cost, total: cost });
export const usageTotalsSchema = z.object({
  calls: count, completedCalls: count, unknownUsageCalls: count,
  inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, totalTokens: count,
  estimatedCost: costSchema.nullable(), estimatedCostCalls: count,
  actualBilledCost: cost.nullable(), actualBilledCostCalls: count,
});
export const usageSchema = z.object({
  accountingStartedAt: z.iso.datetime({ offset: true }), historicalUsageAvailable: z.literal(false), currency: z.literal('USD'),
  totals: usageTotalsSchema,
  series: z.array(z.object({ timestamp: z.iso.datetime({ offset: true }), totals: usageTotalsSchema })),
  seriesTruncated: z.boolean(),
  groups: z.array(z.object({ provider: z.string(), model: z.string(), stage: z.string(), totals: usageTotalsSchema })),
  options: z.object({ models: z.array(z.string()), providers: z.array(z.string()), stages: z.array(z.string()) }),
});
export type Usage = z.infer<typeof usageSchema>;
export const usageCallsSchema = z.object({
  total: count, limit: count.min(1).max(200), offset: count,
  calls: z.array(z.object({
    id: z.uuid(), timestamp: z.iso.datetime({ offset: true }), provider: z.string(), model: z.string(),
    operationId: z.string().nullable(), stage: z.string(), attempt: count, outcome: z.enum(['completed', 'failed']),
    usageKnown: z.boolean(), inputTokens: count.nullable(), outputTokens: count.nullable(), cacheReadTokens: count.nullable(),
    cacheWriteTokens: count.nullable(), totalTokens: count.nullable(), estimatedCost: costSchema.nullable(),
    actualBilledCost: cost.nullable(), durationMs: count,
  })),
});
export type UsageCalls = z.infer<typeof usageCallsSchema>;
export interface UsageFilters { from: string; to: string; model: string; provider: string; stage: string; bucket: 'day' | 'hour' }
export const emptyUsageFilters: UsageFilters = { from: '', to: '', model: '', provider: '', stage: '', bucket: 'day' };
export const usagePageSize = 25;

export function usageQuery(filters: UsageFilters, offset?: number): string {
  const params = new URLSearchParams();
  const from = filters.from ? new Date(filters.from) : null;
  const to = filters.to ? new Date(filters.to) : null;
  if ((from && !Number.isFinite(from.getTime())) || (to && !Number.isFinite(to.getTime()))) throw new Error('Enter valid start and end dates.');
  if (from && to && from >= to) throw new Error('The end date must be later than the start date.');
  if (from) params.set('from', from.toISOString());
  if (to) params.set('to', to.toISOString());
  for (const key of ['model', 'provider', 'stage'] as const) if (filters[key]) params.set(key, filters[key]);
  if (offset === undefined) params.set('bucket', filters.bucket);
  else { params.set('limit', String(usagePageSize)); params.set('offset', String(offset)); }
  return params.toString();
}

export const formatCount = (value: number | null) => value === null ? 'Unavailable' : new Intl.NumberFormat().format(value);
export const formatKnownTokens = (value: number, totals: Pick<Usage['totals'], 'calls' | 'unknownUsageCalls'>) =>
  formatCount(totals.calls > 0 && totals.unknownUsageCalls === totals.calls ? null : value);
export const tokenAccountingNote = 'Input excludes cache read and cache write tokens. The API normalizes these categories for JEV and Codex so they do not overlap. Totals use the API\'s reported token count.';
export const formatCost = (value: number | null) => value === null ? 'Unavailable' : new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6,
}).format(value);
