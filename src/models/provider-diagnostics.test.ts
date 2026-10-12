import { describe, expect, it } from "vitest";
import { classifyProviderError, failureMetadata, failureResponseMetadata, faultFromError, RequestFault } from "./errors.js";
import { providerContextLimit, providerDiagnostics, safeProviderDiagnostics } from "./provider-diagnostics.js";
import { piStreamFailure } from "./pi-failure.js";

describe("bounded provider diagnostics and retry classification", () => {
  it.each([
    ["terminated", "transient", "stream_terminated"],
    ["OpenAI Responses stream ended before a terminal response event", "transient", "stream_eof"],
    ["Codex stream ended without a stop reason", "transient", "stream_eof"],
    ["WebSocket stream closed before response.completed", "transient", "stream_eof"],
    ["stream disconnected before completion: remote closed", "transient", "stream_disconnected"],
    ["No response body", "transient", "missing_body"],
    ["UND_ERR_BODY_TIMEOUT", "timeout", "body_timeout"],
    ["Codex SSE response headers timed out after 1200000ms", "timeout", "headers_timeout"],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout", "headers_timeout"],
    ["Request was aborted", "cancelled", "request_aborted"],
    ["ETIMEDOUT", "timeout", "request_timeout"],
    ["ECONNRESET", "transient", "connection_reset"],
    ["UND_ERR_SOCKET", "transient", "socket_closed"],
    ["upstream connect error or disconnect/reset before headers. reset reason: connection termination", "transient", "upstream_connect_error"],
    ["Invalid Codex SSE JSON: PRIVATE_PAYLOAD", "invalid_output", "stream_protocol_error"],
  ])("classifies SDK reason %s without storing it", (message, kind, transportKind) => {
    expect(classifyProviderError(message, 200)).toBe(kind);
    expect(providerDiagnostics(message)).toEqual({ transportKind });
  });

  it("leaves unrelated or opaque failures manual regardless of elapsed duration", () => {
    for (const message of ["Unknown: UnknownError", "Response incomplete without a provider reason", "Cannot read properties of undefined"]) {
      expect(classifyProviderError(message, 200)).toBe("unknown");
      expect(providerDiagnostics(message)).toEqual({});
    }
    const failure = failureMetadata(new RequestFault("unknown", { status: 200 }), "synthetic", "pi", 1, 901833);
    expect(failure).toMatchObject({ retryable: false, nextRetryAt: null, kind: "unknown" });
  });

  it("delays interrupted accepted streams and honors configured caps without immediate retries", () => {
    const fault = new RequestFault("transient", { status: 200, outcome: "unknown", transportKind: "stream_eof" });
    const fifth = failureMetadata(fault, "synthetic", "pi", 5, 901833, 10_000, 10);
    expect(fifth.nextRetryAt).toBe(new Date(310_000).toISOString());
    expect(failureMetadata(fault, "synthetic", "pi", 10, 901833, 10_000, 10))
      .toMatchObject({ retryable: false, nextRetryAt: null });
    expect(failureMetadata(new RequestFault("transient", { status: 200 }), "synthetic", "pi", 1, 0, 10_000).nextRetryAt)
      .toBe(new Date(310_000).toISOString());
    const notSubmitted = faultFromError(Object.assign(new Error("connection timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }));
    expect(notSubmitted.detail.outcome).toBe("not_submitted");
    expect(failureMetadata(notSubmitted, "synthetic", "pi", 1, 0, 10_000).nextRetryAt).toBe(new Date(15_000).toISOString());
  });

  it("revalidates diagnostic fields and drops all arbitrary provider text", () => {
    const raw: unknown = { providerErrorCode: "PRIVATE_NEW_CODE", streamEvent: "PRIVATE_EVENT",
      transportKind: "PRIVATE_TRANSPORT", message: "PRIVATE_INPUT" };
    expect(safeProviderDiagnostics(raw)).toEqual({});
    expect(safeProviderDiagnostics({ providerErrorCode: "server_error", streamEvent: "error", transportKind: "stream_eof" }))
      .toEqual({ providerErrorCode: "server_error", transportKind: "stream_eof", streamEvent: "error" });
    const failure = failureMetadata(new RequestFault("transient", {
      status: 200, providerErrorCode: "server_error", streamEvent: "error",
    }), "synthetic", "pi", 1, 901833);
    failure.message = "PRIVATE_MESSAGE_NOT_PERSISTED";
    expect(failureResponseMetadata(failure)).toEqual({ outcome: "unknown", durationMs: 901833, status: 200,
      providerErrorCode: "server_error", streamEvent: "error" });
    expect(JSON.stringify(failureResponseMetadata(failure))).not.toContain("PRIVATE_");
  });

  it("does not infer recoverability from prose when an error code has an invalid type", () => {
    const fault = piStreamFailure({ type: "error", code: 123, message: "timeout PRIVATE_INPUT" }, 200);
    expect(fault?.kind).toBe("unknown");
    expect(fault?.detail).toEqual({ streamEvent: "error", status: 200, outcome: "unknown" });
  });

  it('retains the exact bounded numeric Guardian context rejection, not arbitrary provider prose', () => {
    const message = 'request (13327 tokens) exceeds the available context size (12288 tokens), try increasing it';
    const details = providerDiagnostics(message, 'exceed_context_size_error');
    expect(details).toEqual({ providerErrorCode: 'exceed_context_size_error',
      providerContextLimit: { requestTokens: 13327, contextTokens: 12288, message } });
    const failure = failureMetadata(new RequestFault('context_limit', { status: 400, outcome: 'rejected', ...details }),
      'guardian-context-regression', 'jev', 1, 29);
    expect(failure).toMatchObject({ kind: 'context_limit', retryable: false, nextRetryAt: null });
    expect(failureResponseMetadata(failure)).toMatchObject(details);
    expect(providerContextLimit('request (12288 tokens) exceeds the available context size (12288 tokens), try increasing it'))
      .toMatchObject({ requestTokens: 12288, contextTokens: 12288 });
    expect(providerContextLimit('input (12289 tokens) is larger than the max context size (12288 tokens). skipping'))
      .toMatchObject({ requestTokens: 12289, contextTokens: 12288 });
    for (const unsafe of [message + ' PRIVATE_INPUT', 'PRIVATE_INPUT ' + message,
      'request (999999999999999 tokens) exceeds the available context size (12288 tokens), try increasing it',
      'request (1 tokens) exceeds the available context size (0 tokens), try increasing it',
      'request (1 tokens) exceeds the available context size (12288 tokens), try increasing it',
      'input (12288 tokens) is larger than the max context size (12288 tokens). skipping']) {
      expect(providerContextLimit(unsafe)).toBeUndefined();
    }
    expect(safeProviderDiagnostics({ providerContextLimit: { ...details.providerContextLimit, requestTokens: 1 } })).toEqual({});
    expect(safeProviderDiagnostics({ providerContextLimit: { ...details.providerContextLimit, privateInput: 'PRIVATE_INPUT' } }))
      .toEqual({ providerContextLimit: details.providerContextLimit });
  });

  it("ignores deltas and successful terminal envelopes", () => {
    expect(piStreamFailure({ type: "response.output_text.delta", delta: "PRIVATE_INPUT" }, 200)).toBeUndefined();
    expect(piStreamFailure({ type: "response.completed", response: { status: "completed" } }, 200)).toBeUndefined();
  });

  it("keeps explicit cancellation and unknown incomplete reasons terminal", () => {
    expect(piStreamFailure({ type: "response.done", response: { status: "cancelled" } }, 200)?.kind).toBe("cancelled");
    const fault = piStreamFailure({ type: "response.incomplete", response: { status: "incomplete",
      incomplete_details: { reason: "PRIVATE_REASON" } } }, 200);
    expect(fault?.kind).toBe("unknown");
    expect(JSON.stringify(fault?.detail)).not.toContain("PRIVATE_");
  });
});
