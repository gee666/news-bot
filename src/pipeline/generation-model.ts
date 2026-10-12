import { resolve } from 'node:path';
import { db } from '../db.js';
import { PiGenerator, openPiRuntime, ModelRequestError, type ModelFailure, type PiRuntime,
  type TextGenerator } from '../models/index.js';
import { failureMetadata, failureResponseMetadata, RequestFault, type FailureKind } from '../models/errors.js';
import type { ValidationCode } from '../models/structured-diagnostics.js';
import type { AppSettings } from '../settings.js';

let runtime: Promise<PiRuntime> | undefined;
let runtimePath: string | undefined;

export async function recordGenerationFailure(failure: ModelFailure): Promise<void> {
  await db.query(`INSERT INTO request_attempts
    (provider, operation, attempt_number, status, dispatched_at, finished_at, next_retry_at, error_code, response_metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [failure.service, failure.operationId, failure.attempt,
    failure.outcome === 'unknown' ? 'unknown' : failure.retryable ? 'retryable' : 'failed',
    new Date(Date.parse(failure.failedAt) - failure.durationMs).toISOString(), failure.failedAt, failure.nextRetryAt, failure.kind,
    JSON.stringify(failureResponseMetadata(failure))]);
}

export async function generationError(operationId: string, kind: FailureKind, message?: string,
  codes: ValidationCode[] = []): Promise<never> {
  const metadata = failureMetadata(new RequestFault(kind, { outcome: 'not_submitted' }), operationId, 'pi', 1, 0);
  if (message) metadata.message = message;
  if (codes.length) metadata.validation = { schemaBytes: 0, promptChars: 0, responseChars: 0, codes: codes.slice(0, 20), fields: [] };
  await recordGenerationFailure(metadata);
  throw new ModelRequestError(metadata);
}

export async function requireInferenceApproval(accesses: readonly string[], operationId: string): Promise<void> {
  if (accesses.some(access => access !== 'public') && process.env.ALLOW_PRIVATE_INFERENCE !== 'true') {
    await generationError(operationId, 'invalid_request', 'Private or unknown source access requires ALLOW_PRIVATE_INFERENCE=true.');
  }
}

export async function generationClient(settings: AppSettings,
  recorder: (failure: ModelFailure) => Promise<void> = recordGenerationFailure): Promise<TextGenerator> {
  const authPath = process.env.PI_AUTH_PATH ?? resolve('tmp/models-private-auth/auth.json');
  if (!runtime || runtimePath !== authPath) {
    runtimePath = authPath;
    runtime = openPiRuntime(authPath).catch(error => { runtime = undefined; throw error; });
  }
  return new PiGenerator({ runtime: await runtime, provider: settings.piProvider, model: settings.piModel,
    timeoutMs: settings.piTimeoutMs, requestMaxAttempts: settings.requestMaxAttempts, recordFailure: recorder });
}
