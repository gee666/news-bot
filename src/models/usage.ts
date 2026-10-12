import { z } from 'zod';
import type pg from 'pg';
import { db } from '../db.js';
import { originalUsageOperation } from './usage-scope.js';

const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const money = z.number().finite().nonnegative();
export const costSchema = z.object({ input: money, output: money, cacheRead: money, cacheWrite: money, total: money });
export const tokenUsageSchema = z.object({ input: tokens, output: tokens, cacheRead: tokens,
  cacheWrite: tokens, totalTokens: tokens });
export const callUsageSchema = tokenUsageSchema.extend({ estimatedCost: costSchema.optional(),
  actualBilledCost: money.optional() });
export type CallUsage = z.infer<typeof callUsageSchema>;
export interface UsageCall {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  operationId: string | null;
  stage: string;
  attempt: number;
  outcome: 'completed' | 'failed';
  usageKnown: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  estimatedCost: z.infer<typeof costSchema> | null;
  actualBilledCost: number | null;
  durationMs: number;
}
export type UsageRecorder = (call: UsageCall) => Promise<void>;

/** SDK costs come from model catalog prices, not a provider invoice. */
export function sdkUsage(value: unknown): CallUsage | undefined {
  const parsed = tokenUsageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const withCost = z.object({ cost: costSchema }).safeParse(value);
  return { ...parsed.data, ...(withCost.success ? { estimatedCost: withCost.data.cost } : {}) };
}

const codexEnvelopeSchema = z.object({ response: z.object({ usage: z.object({
  input_tokens: tokens, output_tokens: tokens, total_tokens: tokens,
  input_tokens_details: z.object({ cached_tokens: tokens.default(0), cache_write_tokens: tokens.default(0) }).optional(),
}) }) });
export function codexUsage(event: unknown): CallUsage | undefined {
  const parsed = codexEnvelopeSchema.safeParse(event);
  if (!parsed.success) return undefined;
  const value = parsed.data.response.usage;
  const cacheRead = value.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = value.input_tokens_details?.cache_write_tokens ?? 0;
  if (cacheRead + cacheWrite > value.input_tokens) return undefined;
  return { input: value.input_tokens - cacheRead - cacheWrite, output: value.output_tokens,
    cacheRead, cacheWrite, totalTokens: value.total_tokens };
}

export function operationStage(operationId: string): string {
  // UUID stage IDs resolve from stage_state when persisted; labels retain only their task names.
  return operationId.split(':').filter(part => !z.uuid().safeParse(part).success).join(':') || 'model';
}

export async function recordUsage(call: UsageCall, pool: pg.Pool = db): Promise<void> {
  const original = originalUsageOperation(call.operationId);
  await pool.query(`INSERT INTO model_usage_calls
    (id,timestamp,provider,model,operation_id,stage,attempt,outcome,usage_known,
     input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,
     estimated_cost,actual_billed_cost,duration_ms)
    VALUES ($1,$2,$3,$4,$5,COALESCE(
      (SELECT stage || $18 FROM stage_state WHERE id::text=$19),$6),
      $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (id) DO NOTHING`,
  [call.id, call.timestamp, call.provider, call.model, call.operationId, call.stage, call.attempt,
    call.outcome, call.usageKnown, call.inputTokens, call.outputTokens, call.cacheReadTokens,
    call.cacheWriteTokens, call.totalTokens, call.estimatedCost === null ? null : JSON.stringify(call.estimatedCost),
    call.actualBilledCost, call.durationMs,
    original?.includes(':') ? ':' + original.split(':').slice(1).join(':') : '',
    original?.split(':')[0] ?? '']);
}
