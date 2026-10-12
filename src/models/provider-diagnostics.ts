import type { FailureKind } from "./errors.js";
import { jevContextBudgetSchema, type JevContextBudget } from './jev-budget.js';

// Fixed labels and the exact numeric context grammar only. Arbitrary provider prose can contain private input.
const providerCodes = [
  { code: "server_error", kind: "transient" },
  { code: "internal_error", kind: "transient" },
  { code: "internal_server_error", kind: "transient" },
  { code: "service_unavailable", kind: "transient" },
  { code: "overloaded_error", kind: "transient" },
  { code: "request_timeout", kind: "timeout" },
  { code: "context_length_exceeded", kind: "context_limit" },
  { code: "exceed_context_size_error", kind: "context_limit" },
  { code: "rate_limit_exceeded", kind: "throttled" },
  { code: "usage_limit_reached", kind: "throttled" },
  { code: "insufficient_quota", kind: "throttled" },
  { code: "invalid_api_key", kind: "authentication" },
  { code: "invalid_grant", kind: "authentication" },
  { code: "invalid_token", kind: "authentication" },
  { code: "account_deactivated", kind: "authentication" },
  { code: "model_not_found", kind: "model_unavailable" },
  { code: "invalid_request_error", kind: "invalid_request" },
  { code: "invalid_prompt", kind: "invalid_request" },
  { code: "unsupported_parameter", kind: "invalid_request" },
  { code: "content_filter", kind: "invalid_request" },
  { code: "max_output_tokens", kind: "invalid_output" },
] as const satisfies ReadonlyArray<{ code: string; kind: FailureKind }>;
const transportRules = [
  { label: "connect_timeout", kind: "timeout", pattern: /\bUND_ERR_CONNECT_TIMEOUT\b/ },
  { label: "headers_timeout", kind: "timeout", pattern: /\bUND_ERR_HEADERS_TIMEOUT\b|Codex SSE response headers timed out after \d+ms/i },
  { label: "body_timeout", kind: "timeout", pattern: /\bUND_ERR_BODY_TIMEOUT\b/ },
  { label: "request_timeout", kind: "timeout", pattern: /\bETIMEDOUT\b|\btimeout\b|\btimed out\b|\bdeadline\b/i },
  { label: "connection_reset", kind: "transient", pattern: /\bECONNRESET\b|\bEPIPE\b/ },
  { label: "network_unavailable", kind: "transient", pattern: /\bECONNREFUSED\b|\bENOTFOUND\b|\bEAI_AGAIN\b|^fetch failed$/i },
  { label: "upstream_connect_error", kind: "transient", pattern: /^upstream connect error or disconnect\/reset before headers/i },
  { label: "socket_closed", kind: "transient", pattern: /\bUND_ERR_SOCKET\b|^other side closed$/i },
  { label: "stream_terminated", kind: "transient", pattern: /^(?:TypeError:\s*)?terminated$/i },
  { label: "stream_eof", kind: "transient", pattern: /^(?:OpenAI Responses stream ended before a terminal response event|Codex stream ended without a stop reason|WebSocket stream closed before response\.completed)$/ },
  { label: "stream_disconnected", kind: "transient", pattern: /^stream disconnected before completion(?:[:;]|$)/i },
  { label: "missing_body", kind: "transient", pattern: /^No response body$/ },
  { label: "request_aborted", kind: "cancelled", pattern: /^Request was aborted$/ },
  { label: "stream_protocol_error", kind: "invalid_output", pattern: /^Invalid Codex SSE JSON:/ },
] as const;
const localTransportKinds = ["local_deadline", "local_cancelled"] as const;
const streamEvents = ["error", "response.error", "response.failed", "response.incomplete", "response.completed", "response.done"] as const;
export interface ProviderContextLimit {
  requestTokens: number;
  contextTokens: number;
  /** Only the exact fixed numeric provider grammar is retained, never arbitrary prose. */
  message: string;
}
export function providerContextLimit(message: string): ProviderContextLimit | undefined {
  if (message.length > 200) return undefined;
  const matched = /^request \((\d{1,10}) tokens\) exceeds the available context size \((\d{1,10}) tokens\), try increasing it$/u.exec(message)
    ?? /^input \((\d{1,10}) tokens\) is larger than the max context size \((\d{1,10}) tokens\)\. skipping$/u.exec(message);
  if (!matched) return undefined;
  const requestTokens = Number(matched[1]);
  const contextTokens = Number(matched[2]);
  if (contextTokens < 1 || requestTokens < contextTokens
    || (message.startsWith('input (') && requestTokens === contextTokens)) return undefined;
  return { requestTokens, contextTokens, message };
}
export interface ProviderDiagnostics {
  jevContextBudget?: JevContextBudget;
  providerContextLimit?: ProviderContextLimit;
  providerErrorCode?: typeof providerCodes[number]["code"] | "unrecognized";
  transportKind?: typeof transportRules[number]["label"] | typeof localTransportKinds[number];
  streamEvent?: typeof streamEvents[number];
}

export function knownProviderCode(value: unknown) {
  return providerCodes.find(entry => entry.code === value);
}
export function transportFailure(message: string) {
  return transportRules.find(entry => entry.pattern.test(message));
}
export function providerDiagnostics(message: string, code?: unknown): ProviderDiagnostics {
  const known = knownProviderCode(code);
  const transport = code === undefined || known?.kind === "transient" || known?.kind === "timeout"
    ? transportFailure(message) : undefined;
  const context = (code === undefined || known?.kind === 'context_limit') ? providerContextLimit(message) : undefined;
  return { ...(typeof code === "string" ? { providerErrorCode: known?.code ?? "unrecognized" } : {}),
    ...(context ? { providerContextLimit: context } : {}), ...(transport ? { transportKind: transport.label } : {}) };
}

/** Revalidate even typed caller metadata, rather than spreading arbitrary diagnostics into storage. */
export function safeProviderDiagnostics(value: unknown): ProviderDiagnostics {
  if (!value || typeof value !== "object") return {};
  const rawCode: unknown = Reflect.get(value, "providerErrorCode");
  const rawTransport: unknown = Reflect.get(value, "transportKind");
  const rawEvent: unknown = Reflect.get(value, "streamEvent");
  const code = knownProviderCode(rawCode)?.code ?? (rawCode === "unrecognized" ? "unrecognized" : undefined);
  const transport = transportRules.find(entry => entry.label === rawTransport)?.label
    ?? localTransportKinds.find(label => label === rawTransport);
  const event = streamEvents.find(label => label === rawEvent);
  const rawContext: unknown = Reflect.get(value, 'providerContextLimit');
  const context = rawContext && typeof rawContext === 'object' && 'message' in rawContext && typeof rawContext.message === 'string'
    ? providerContextLimit(rawContext.message) : undefined;
  const validContext = context && rawContext && typeof rawContext === 'object'
    && Reflect.get(rawContext, 'requestTokens') === context.requestTokens && Reflect.get(rawContext, 'contextTokens') === context.contextTokens
    && (!code || knownProviderCode(code)?.kind === 'context_limit') ? context : undefined;
  const budget = jevContextBudgetSchema.safeParse(Reflect.get(value, 'jevContextBudget'));
  return { ...(budget.success ? { jevContextBudget: budget.data } : {}), ...(validContext ? { providerContextLimit: validContext } : {}),
    ...(code ? { providerErrorCode: code } : {}), ...(transport ? { transportKind: transport } : {}),
    ...(event ? { streamEvent: event } : {}) };
}
