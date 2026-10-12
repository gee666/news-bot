import { classifyProviderError, providerRetryTime, RequestFault } from "./errors.js";
import { knownProviderCode, providerDiagnostics } from "./provider-diagnostics.js";

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Captures only error envelopes, never token deltas or provider text for persistence. */
export function piStreamFailure(event: unknown, status?: number): RequestFault | undefined {
  if (!isObject(event)) return undefined;
  const response = isObject(event.response) ? event.response : undefined;
  const type = event.type;
  if (type !== "error" && type !== "response.error" && type !== "response.failed"
    && type !== "response.incomplete" && type !== "response.completed" && type !== "response.done") return undefined;
  const incomplete = type === "response.incomplete" || response?.status === "incomplete";
  const terminalError = type === "error" || type === "response.error" || type === "response.failed"
    || incomplete || response?.status === "failed" || response?.status === "cancelled";
  if (!terminalError) return undefined;
  const embeddedError = response && isObject(response.error) ? response.error
    : isObject(event.error) ? event.error : undefined;
  const error = embeddedError ?? event;
  const reason = response && isObject(response.incomplete_details) ? response.incomplete_details.reason : undefined;
  const code = typeof event.code === "string" ? event.code : error.code ?? embeddedError?.type ?? (incomplete ? reason : undefined);
  const message = typeof event.message === "string" ? event.message : typeof error.message === "string" ? error.message : "";
  const reset = error.resets_at ?? event.resets_at;
  const resetAt = typeof reset === "number" && Number.isFinite(reset) && reset >= 0 && reset <= 8.64e12
    ? reset * 1000 : undefined;
  const retryAt = resetAt ?? providerRetryTime(message);
  const unknownCode = code !== undefined && !knownProviderCode(code);
  const kind = response?.status === "cancelled" ? "cancelled"
    : unknownCode && (status === undefined || status < 400) ? "unknown" : classifyProviderError(message, status, code);
  return new RequestFault(kind, { ...providerDiagnostics(message, code), streamEvent: type,
    ...(status === undefined ? {} : { status }), ...(retryAt === undefined ? {} : { retryAt }),
    outcome: "unknown" });
}
