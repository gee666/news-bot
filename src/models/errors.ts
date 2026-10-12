import { safeStructuredDiagnostics, type StructuredDiagnostics } from './structured-diagnostics.js';
import { knownProviderCode, providerDiagnostics, safeProviderDiagnostics, transportFailure,
  type ProviderDiagnostics } from "./provider-diagnostics.js";

export type FailureKind = "authentication" | "model_unavailable" | "invalid_request"
  | "context_limit" | "throttled" | "transient" | "timeout" | "cancelled" | "invalid_output" | "unknown";

export interface ModelFailure extends ProviderDiagnostics {
  operationId: string;
  service: "jev" | "embedding" | "pi";
  kind: FailureKind;
  message: string;
  attempt: number;
  failedAt: string;
  nextRetryAt: string | null;
  retryable: boolean;
  outcome: "not_submitted" | "rejected" | "unknown";
  status?: number;
  requestId?: string;
  durationMs: number;
  validation?: StructuredDiagnostics;
}

export function failureResponseMetadata(failure: ModelFailure) {
  const validation = safeStructuredDiagnostics(failure.validation);
  return { ...(validation ? { validation } : {}), outcome: failure.outcome, durationMs: failure.durationMs, status: failure.status,
    ...safeProviderDiagnostics(failure) };
}

export class RequestFault extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly detail: { status?: number; requestId?: string; retryAt?: number;
      outcome?: ModelFailure["outcome"] } & ProviderDiagnostics = {},
  ) { super(kind); }
}

export class ModelRequestError extends Error {
  constructor(readonly metadata: ModelFailure) {
    super(metadata.message);
    this.name = "ModelRequestError";
  }
}

const messages: Record<FailureKind, string> = {
  authentication: "Model authentication needs correction.",
  model_unavailable: "The configured model is unavailable.",
  invalid_request: "The model request needs correction.",
  context_limit: "The input exceeds the model context. Split it before retrying.",
  throttled: "The provider reported a rate or usage limit.",
  transient: "The model service is temporarily unavailable.",
  timeout: "The request deadline expired; server-side completion is unknown.",
  cancelled: "The request was cancelled.",
  invalid_output: "The model returned invalid output.",
  unknown: "The model request failed; inspect service diagnostics.",
};

export function retryTime(headers: Headers, now = Date.now()): number | undefined {
  const millis = headers.get("retry-after-ms");
  if (millis !== null && Number.isFinite(Number(millis))) return now + Math.max(0, Number(millis));
  const after = headers.get("retry-after");
  if (after !== null) {
    if (Number.isFinite(Number(after))) return now + Math.max(0, Number(after) * 1000);
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens"]) {
    const value = headers.get(name);
    if (!value) continue;
    if (/^\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      return Math.max(now, n < 1e12 ? n * 1000 : n);
    }
    const duration = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value);
    if (duration && duration[0]) {
      return now + (Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60
        + Number(duration[3] ?? 0)) * 1000;
    }
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(now, date);
  }
  return undefined;
}

export function classifyProviderError(message: string, status?: number, code?: unknown): FailureKind {
  // Structured provider codes take precedence over ambiguous prose, including HTTP-200 SSE errors.
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404) return 'model_unavailable';
  const known = knownProviderCode(code);
  if (known) return known.kind;
  if (/context.{0,30}(length|window|limit|size)|too many tokens|input.{0,20}too long/i.test(message)) return "context_limit";
  if (/unauthorized|invalid.grant|token.{0,20}(expired|refresh)|authentication/i.test(message)) return "authentication";
  if (/model.{0,40}(not found|not supported|unavailable|does not exist)/i.test(message)) return "model_unavailable";
  if (status === 429 || /rate.?limit|usage.?limit|quota|try again in/i.test(message)) return "throttled";
  if (/timeout|timed out|deadline/i.test(message) || status === 504) return "timeout";
  if (status === 400 || status === 413 || status === 415 || status === 422) return "invalid_request";
  const transport = transportFailure(message);
  if (transport) return transport.kind;
  if ((status !== undefined && [500, 502, 503].includes(status))
    || /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket|overloaded|service.?unavailable/i.test(message)) return "transient";
  return "unknown";
}

/** Pi's Codex adapter normalizes HTTP usage-limit reset timestamps to rounded minutes. */
export function providerRetryTime(message: string, now = Date.now()): number | undefined {
  const minutes = /try again in\s*~?(\d+(?:\.\d+)?)\s*min/i.exec(message);
  if (minutes?.[1]) return now + (Number(minutes[1]) + 1) * 60_000;
  const delay = /server requested\s+(\d+)s retry delay/i.exec(message);
  return delay?.[1] ? now + Number(delay[1]) * 1000 : undefined;
}

export function faultFromError(error: unknown): RequestFault {
  if (error instanceof RequestFault) return error;
  let current: unknown = error;
  const details: string[] = [];
  let notSubmitted = false;
  let providerCode: string | undefined;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    details.push(current.message);
    if ("code" in current && typeof current.code === "string") {
      details.push(current.code);
      if (knownProviderCode(current.code)) providerCode ??= current.code;
      if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(current.code)) {
        notSubmitted = true;
      }
    }
    current = current.cause;
  }
  const message = details.join(" ");
  const retryAt = providerRetryTime(message);
  return new RequestFault(notSubmitted ? "transient" : classifyProviderError(message, undefined, providerCode),
    { ...providerDiagnostics(message, providerCode), outcome: notSubmitted ? "not_submitted" : "unknown",
      ...(retryAt === undefined ? {} : { retryAt }) });
}

export function canRetryFailure(kind: FailureKind, attempt: number, requestMaxAttempts = 5): boolean {
  return kind === "throttled" || (attempt < requestMaxAttempts && ["transient", "timeout"].includes(kind));
}

export function failureMetadata(
  fault: RequestFault, operationId: string, service: ModelFailure["service"],
  attempt: number, durationMs: number, now = Date.now(), requestMaxAttempts = 5,
): ModelFailure {
  const kind = fault.kind;
  const retryable = canRetryFailure(kind, attempt, requestMaxAttempts);
  // An interrupted accepted stream can still be running remotely. Never immediately resubmit it.
  const uncertainStream = service === "pi" && fault.detail.outcome !== "not_submitted"
    && ((fault.detail.status !== undefined && fault.detail.status >= 200 && fault.detail.status < 300)
      || fault.detail.streamEvent !== undefined || fault.detail.transportKind !== undefined);
  const delay = kind === "timeout" || (kind === "transient" && uncertainStream)
    ? 300_000 : Math.min(300_000, 5000 * 2 ** Math.min(attempt - 1, 6));
  const next = retryable ? Math.max(now + delay, fault.detail.retryAt ?? 0) : null;
  return {
    operationId, service, kind, message: fault.detail.jevContextBudget && kind === 'context_limit'
      ? 'The complete JEV prompt cannot fit the safe context budget. Leave the decision unresolved pending bounded full-input evaluation.'
      : messages[kind], attempt, durationMs,
    failedAt: new Date(now).toISOString(),
    nextRetryAt: next === null ? null : new Date(next).toISOString(),
    retryable, outcome: fault.detail.outcome ?? "unknown", ...safeProviderDiagnostics(fault.detail),
    ...(fault.detail.status === undefined ? {} : { status: fault.detail.status }),
    ...(fault.detail.requestId === undefined ? {} : { requestId: fault.detail.requestId }),
  };
}
