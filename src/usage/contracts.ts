import { z } from 'zod';
import { costSchema } from '../models/usage.js';

const filter = z.string().trim().min(1).max(256);
const datetime = z.iso.datetime({ offset: true });
const filters = { from: datetime.optional(), to: datetime.optional(), model: filter.optional(),
  provider: filter.optional(), stage: filter.optional() };
const validRange = (value: { from?: string | undefined; to?: string | undefined }) =>
  !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to);
export const usageQuerySchema = z.object({ ...filters, bucket: z.enum(['day', 'hour']).default('day') })
  .strict().refine(validRange, 'from must precede to');
export const callsQuerySchema = z.object({ ...filters,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
}).strict().refine(validRange, 'from must precede to');
export type UsageQuery = z.infer<typeof usageQuerySchema>;
export type CallsQuery = z.infer<typeof callsQuerySchema>;

const count = z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.coerce.number().finite().nonnegative();
export const totalsSchema = z.object({
  calls: count, completedCalls: count, unknownUsageCalls: count,
  inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, totalTokens: count,
  estimatedCost: costSchema.nullable(), estimatedCostCalls: count,
  actualBilledCost: money.nullable(), actualBilledCostCalls: count,
});
export const usageStatsSchema = z.object({ accountingStartedAt: z.string(), historicalUsageAvailable: z.literal(false),
  currency: z.literal('USD'), totals: totalsSchema,
  series: z.array(z.object({ timestamp: z.string(), totals: totalsSchema })), seriesTruncated: z.boolean(),
  groups: z.array(z.object({ provider: z.string(), model: z.string(), stage: z.string(), totals: totalsSchema })),
  options: z.object({ models: z.array(z.string()), providers: z.array(z.string()), stages: z.array(z.string()) }),
});
export const usageCallSchema = z.object({
  id: z.uuid(), timestamp: z.string(), provider: z.string(), model: z.string(), operationId: z.string().nullable(),
  stage: z.string(), attempt: count, outcome: z.enum(['completed', 'failed']), usageKnown: z.boolean(),
  inputTokens: count.nullable(), outputTokens: count.nullable(), cacheReadTokens: count.nullable(),
  cacheWriteTokens: count.nullable(), totalTokens: count.nullable(), estimatedCost: costSchema.nullable(),
  actualBilledCost: money.nullable(), durationMs: count,
});
export const callsPageSchema = z.object({ total: count, limit: count, offset: count, calls: z.array(usageCallSchema) });
export type UsageStats = z.infer<typeof usageStatsSchema>;
export type CallsPage = z.infer<typeof callsPageSchema>;
export interface UsageServices {
  usage(query: UsageQuery): Promise<UsageStats>;
  usageCalls(query: CallsQuery): Promise<CallsPage>;
}
