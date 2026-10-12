import type pg from 'pg';
import { z } from 'zod';
import { db } from '../db.js';
import { callsPageSchema, totalsSchema, usageStatsSchema, type CallsPage, type CallsQuery,
  type UsageQuery, type UsageStats } from './contracts.js';

// Compute aggregates in PostgreSQL rather than loading all historical call rows into the server.
const aggregate = `count(*) AS "calls",
  count(*) FILTER (WHERE outcome='completed') AS "completedCalls",
  count(*) FILTER (WHERE NOT usage_known) AS "unknownUsageCalls",
  COALESCE(sum(input_tokens),0) AS "inputTokens", COALESCE(sum(output_tokens),0) AS "outputTokens",
  COALESCE(sum(cache_read_tokens),0) AS "cacheReadTokens", COALESCE(sum(cache_write_tokens),0) AS "cacheWriteTokens",
  COALESCE(sum(total_tokens),0) AS "totalTokens",
  CASE WHEN count(estimated_cost)>0 THEN jsonb_build_object(
    'input',sum((estimated_cost->>'input')::numeric), 'output',sum((estimated_cost->>'output')::numeric),
    'cacheRead',sum((estimated_cost->>'cacheRead')::numeric), 'cacheWrite',sum((estimated_cost->>'cacheWrite')::numeric),
    'total',sum((estimated_cost->>'total')::numeric)) ELSE NULL END AS "estimatedCost",
  count(estimated_cost) AS "estimatedCostCalls", sum(actual_billed_cost) AS "actualBilledCost",
  count(actual_billed_cost) AS "actualBilledCostCalls"`;

function where(query: UsageQuery | CallsQuery): { sql: string; values: string[] } {
  const conditions: string[] = [];
  const values: string[] = [];
  for (const [key, column, operator] of [
    ['from', 'timestamp', '>='], ['to', 'timestamp', '<'], ['model', 'model', '='],
    ['provider', 'provider', '='], ['stage', 'stage', '='],
  ] as const) {
    const value = query[key];
    if (value !== undefined) { values.push(value); conditions.push(`${column} ${operator} $${values.length}`); }
  }
  return { sql: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', values };
}
const isoDate = z.coerce.date().transform(date => date.toISOString());
const seriesRow = totalsSchema.extend({ timestamp: isoDate });
const groupRow = totalsSchema.extend({ provider: z.string(), model: z.string(), stage: z.string() });
const optionsRow = z.object({ models: z.array(z.string()).nullable(), providers: z.array(z.string()).nullable(),
  stages: z.array(z.string()).nullable() });

export async function usageStats(query: UsageQuery, pool: pg.Pool = db): Promise<UsageStats> {
  const client = await pool.connect();
  try {
    // Every component of the response sees the same calls, even while inference completes.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const filter = where(query);
    const metadata = await client.query('SELECT started_at FROM model_usage_accounting');
    const total = await client.query(`SELECT ${aggregate} FROM model_usage_calls ${filter.sql}`, filter.values);
    const groups = await client.query(`SELECT provider,model,stage,${aggregate}
      FROM model_usage_calls ${filter.sql} GROUP BY provider,model,stage ORDER BY provider,model,stage`, filter.values);
    const series = await client.query(`SELECT date_trunc($${filter.values.length + 1},timestamp AT TIME ZONE 'UTC')
      AT TIME ZONE 'UTC' AS timestamp,${aggregate} FROM model_usage_calls ${filter.sql}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 1001`, [...filter.values, query.bucket]);
    const options = await client.query(`SELECT array_agg(DISTINCT model ORDER BY model) AS models,
      array_agg(DISTINCT provider ORDER BY provider) AS providers,
      array_agg(DISTINCT stage ORDER BY stage) AS stages FROM model_usage_calls`);
    await client.query('COMMIT');
    const choices = optionsRow.parse(options.rows[0]);
    return usageStatsSchema.parse({
      accountingStartedAt: z.object({ started_at: isoDate }).parse(metadata.rows[0]).started_at,
      historicalUsageAvailable: false, currency: 'USD', totals: totalsSchema.parse(total.rows[0]),
      series: series.rows.slice(0, 1000).reverse().map(row => {
        const { timestamp, ...totals } = seriesRow.parse(row); return { timestamp, totals };
      }), seriesTruncated: series.rows.length > 1000,
      groups: groups.rows.map(row => { const { provider, model, stage, ...totals } = groupRow.parse(row);
        return { provider, model, stage, totals }; }),
      options: { models: choices.models ?? [], providers: choices.providers ?? [], stages: choices.stages ?? [] },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function usageCalls(query: CallsQuery, pool: pg.Pool = db): Promise<CallsPage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const filter = where(query);
    const total = await client.query(`SELECT count(*) AS total FROM model_usage_calls ${filter.sql}`, filter.values);
    const calls = await client.query(`SELECT id,timestamp,provider,model,operation_id AS "operationId",stage,attempt,
      outcome,usage_known AS "usageKnown",input_tokens AS "inputTokens",output_tokens AS "outputTokens",
      cache_read_tokens AS "cacheReadTokens",cache_write_tokens AS "cacheWriteTokens",total_tokens AS "totalTokens",
      estimated_cost AS "estimatedCost",actual_billed_cost AS "actualBilledCost",duration_ms AS "durationMs"
      FROM model_usage_calls ${filter.sql} ORDER BY timestamp DESC,id DESC
      LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
    [...filter.values, query.limit, query.offset]);
    await client.query('COMMIT');
    return callsPageSchema.parse({ total: z.object({ total: z.coerce.number() }).parse(total.rows[0]).total,
      limit: query.limit, offset: query.offset,
      calls: calls.rows.map(row => { const data = z.object({ timestamp: isoDate }).passthrough().parse(row);
        return { ...data, timestamp: data.timestamp }; }),
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
