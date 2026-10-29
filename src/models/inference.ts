import { randomUUID } from 'node:crypto';
import { callUsageSchema, operationStage, type CallUsage, type UsageRecorder } from './usage.js';
import { deliverUsage, reportUsageStorageFailure, type UsageFailureReporter } from './usage-delivery.js';
import { faultFromError, failureMetadata, ModelRequestError, RequestFault,
  type ModelFailure } from "./errors.js";

export interface RequestContext {
  /** Stable database stage/test identifier. Never put source text or secrets here. */
  operationId: string;
  attempt?: number;
  stage?: string;
  signal?: AbortSignal;
}
export type FailureRecorder = (failure: ModelFailure) => Promise<void>;

type Waiting = { resolve: (release: () => void) => void; reject: (error: unknown) => void;
  signal?: AbortSignal; abort: () => void };

/** All clients, including settings-page tests, share this process-wide gate. */
export class InferenceLimiter {
  private active = false;
  private readonly waiting: Waiting[] = [];

  acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiting = { resolve, reject, ...(signal ? { signal } : {}),
        abort: () => {
          const index = this.waiting.indexOf(waiter);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new RequestFault("cancelled", { outcome: "not_submitted" }));
        } };
      if (!this.active) {
        this.active = true;
        resolve(this.release());
      } else {
        this.waiting.push(waiter);
        signal?.addEventListener("abort", waiter.abort, { once: true });
      }
    });
  }

  private release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (!next) { this.active = false; return; }
      next.signal?.removeEventListener("abort", next.abort);
      next.resolve(this.release());
    };
  }
}
export const inferenceLimiter = new InferenceLimiter();

export interface InferenceOptions {
  recordFailure: FailureRecorder;
  recordUsage?: UsageRecorder;
  /** Total attempts, including throttling and transport/deadline failures. */
  requestMaxAttempts?: number;
}
export interface Dispatch {
  signal: AbortSignal;
  startedAt: number;
  submitted(): void;
  completed(usage?: CallUsage, model?: string): void;
  reportedUsage(usage: CallUsage, model?: string): void;
}
export interface UsageAccounting {
  provider: string;
  model: string;
  recordUsage?: UsageRecorder | undefined;
  usageOutboxDirectory?: string | undefined;
  reportUsageFailure?: UsageFailureReporter | undefined;
}

export async function infer<T>(
  service: ModelFailure["service"], timeoutMs: number, context: RequestContext,
  recordFailure: FailureRecorder, execute: (dispatch: Dispatch) => Promise<T>, requestMaxAttempts = 3,
  accounting?: UsageAccounting,
): Promise<T> {
  if (!context.operationId || !Number.isSafeInteger(context.attempt ?? 1) || (context.attempt ?? 1) < 1) {
    throw new Error("A stable operationId and positive attempt are required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("A positive request deadline is required");
  if (!Number.isSafeInteger(requestMaxAttempts) || requestMaxAttempts < 1) {
    throw new Error("requestMaxAttempts must be a positive integer");
  }
  let release: (() => void) | undefined;
  let startedAt: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const callId = randomUUID();
  let submitted = false;
  let completed = false;
  let usage: CallUsage | undefined;
  let responseModel = accounting?.model;
  let finishedAt: number | undefined;
  const controller = new AbortController();
  const signal = context.signal ? AbortSignal.any([controller.signal, context.signal]) : controller.signal;
  try {
    if (context.signal?.aborted) throw new RequestFault("cancelled", { outcome: "not_submitted" });
    release = await inferenceLimiter.acquire(context.signal);
    startedAt = Date.now();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    return await execute({ signal, startedAt,
      submitted: () => { submitted = true; },
      completed: (value, model) => { completed = true; usage = callUsageSchema.safeParse(value).data; responseModel = model ?? responseModel;
        finishedAt = Date.now(); },
      reportedUsage: (value, model) => { usage = callUsageSchema.safeParse(value).data; responseModel = model ?? responseModel; },
    });
  } catch (error) {
    finishedAt ??= Date.now();
    const original = faultFromError(error);
    const fault = controller.signal.aborted ? new RequestFault("timeout", {
      ...original.detail, transportKind: "local_deadline", outcome: "unknown" })
      : context.signal?.aborted ? new RequestFault("cancelled", {
        ...original.detail, transportKind: "local_cancelled",
        outcome: startedAt === undefined ? "not_submitted" : "unknown" })
      : original;
    const metadata = failureMetadata(fault, context.operationId, service, context.attempt ?? 1,
      startedAt === undefined ? 0 : Date.now() - startedAt, Date.now(), requestMaxAttempts);
    // Keep provider retry metadata even if the host cannot persist its failure record.
    try { await recordFailure(metadata); }
    catch { reportUsageStorageFailure(callId, 'failure_record', accounting?.reportUsageFailure); }
    throw new ModelRequestError(metadata);
  } finally {
    if (timer) clearTimeout(timer);
    release?.();
    // Persist after the provider call, independently of downstream output validation/failure recording.
    if (submitted && accounting && startedAt !== undefined) {
      const label = operationStage(context.operationId);
      await deliverUsage({ id: callId, timestamp: new Date(finishedAt ?? Date.now()).toISOString(),
        provider: accounting.provider, model: responseModel ?? accounting.model,
        operationId: context.operationId, stage: context.stage ?? (label === 'model' ? service : label),
        attempt: context.attempt ?? 1, outcome: completed ? 'completed' : 'failed', usageKnown: usage !== undefined,
        inputTokens: usage?.input ?? null, outputTokens: usage?.output ?? null,
        cacheReadTokens: usage?.cacheRead ?? null, cacheWriteTokens: usage?.cacheWrite ?? null,
        totalTokens: usage?.totalTokens ?? null, estimatedCost: usage?.estimatedCost ?? null,
        actualBilledCost: usage?.actualBilledCost ?? null, durationMs: (finishedAt ?? Date.now()) - startedAt },
      { record: accounting.recordUsage, directory: accounting.usageOutboxDirectory, report: accounting.reportUsageFailure });
    }
  }
}
