import { z } from 'zod';
import { runNowProgressSchema } from '../src/pipeline/run-now-contract.js';
import { publicStatusSchema } from '../src/http/contracts.js';

const text = z.string();
const number = z.number().finite();
const integer = (min: number, max: number) => number.int().min(min).max(max);
export const settingsSchema = z.object({
  interestProfile: text.min(1).max(20000), jevUrl: z.url(), jevModel: text.min(1), embeddingUrl: z.url(), embeddingModel: text.min(1),
  embeddingDimensions: integer(1, 65535), embeddingInputVersion: text.min(1), embeddingContextTokens: integer(128, 131072),
  piProvider: text.min(1), piModel: text.min(1), researchThreshold: integer(1, 10), minimumPublicationScore: integer(1, 10),
  collectionCron: text.min(1), digestCron: text.min(1), cleanupCron: text.min(1), timezone: text.min(1), retentionDays: integer(1, 365),
  publishingEnabled: z.boolean(), jevTimeoutMs: integer(1200000, 86400000), embeddingTimeoutMs: integer(1000, 86400000), piTimeoutMs: integer(1000, 86400000),
  connectionTimeoutMs: integer(100, 60000), prefixCacheEnabled: z.boolean(), collectionWindowHours: integer(1, 48),
  matchCandidateLimit: integer(1, 100), headlineBatchSize: integer(1, 10), researchMaxPages: integer(1, 20), researchMaxSearches: integer(0, 10),
  requestMaxAttempts: integer(1, 20), retryBaseMs: integer(1000, 3600000), retryMaxMs: integer(1000, 86400000),
});
export type Settings = z.infer<typeof settingsSchema>;
export const sourceSchema = z.object({ id: z.uuid(), name: text, externalId: text, access: text, enabled: z.boolean(), active: z.boolean() });
export type Source = z.infer<typeof sourceSchema>;
export const loginSchema = z.object({ provider: text, connected: z.boolean(), login: z.object({
  id: z.uuid(), phase: z.enum(['starting', 'awaiting_redirect', 'exchanging', 'complete', 'failed', 'cancelled']),
  expiresAt: text, authorizationUrl: z.url().optional(), message: text.optional(),
}).nullable() });
export type Login = z.infer<typeof loginSchema>;
export const operationKindSchema = z.enum(['test_jev', 'test_embedding', 'test_pi', 'collection', 'digest', 'cleanup', 'refresh_sources', 'run_now']);
export type OperationKind = z.infer<typeof operationKindSchema>;
export const operationSchema = z.object({ id: z.uuid(), batchId: z.uuid().optional(), runNow: runNowProgressSchema.optional(), kind: operationKindSchema,
  status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'completed_with_errors', 'failed']), attempt: number,
  createdAt: text, updatedAt: text, nextRetryAt: text.nullable(), message: text,
  failure: z.object({ kind: text, outcome: text, durationMs: number }).nullable(),
});
export type Operation = z.infer<typeof operationSchema>;
export const statusSchema = publicStatusSchema;
export type Status = z.infer<typeof statusSchema>;

export const runtimeSchema = z.object({
  automaticWorkEnabled: z.boolean(), manualMutationsAllowed: z.boolean(),
});
export type RuntimeStatus = z.infer<typeof runtimeSchema>;

let csrfToken = '';
export async function connect(): Promise<void> {
  const session = await request('/session', z.object({ csrfToken: text }));
  csrfToken = session.csrfToken;
}
export async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, method = 'POST', signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : method,
    credentials: 'same-origin', cache: 'no-store', ...(signal ? { signal } : {}), headers: body === undefined ? {} : {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const error = z.object({ error: text }).safeParse(await response.json().catch(() => null));
    throw new Error(error.success ? error.data.error : `Request failed with HTTP ${response.status}.`);
  }
  return schema.parse(response.status === 204 ? null : await response.json());
}
