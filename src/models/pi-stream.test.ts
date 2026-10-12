import { resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from 'zod';
import { generateStructured } from './structured.js';
import { recordUsage } from './usage.js';
import { PiGenerator } from "./pi.js";
import type { ModelFailure } from "./errors.js";

vi.mock('./usage.js', async importOriginal => ({
  ...await importOriginal<typeof import('./usage.js')>(), recordUsage: vi.fn(async () => {}),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

async function generator(recordFailure: (failure: ModelFailure) => Promise<void>, timeoutMs = 1_200_000) {
  const credentials = new InMemoryCredentialStore();
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": {
    chatgpt_account_id: "synthetic-account",
  } })).toString("base64url");
  await credentials.modify("openai-codex", async () => ({
    type: "oauth", access: `synthetic.${payload}.synthetic`, refresh: "synthetic-refresh", expires: Date.now() + 3600_000,
  }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  return new PiGenerator({ runtime: { modelRuntime: runtime, agentDir: resolve("tmp/fake-auth"),
    authPath: resolve("tmp/fake-auth/auth.json") }, recordFailure, timeoutMs });
}
const request = { systemPrompt: "Synthetic no-tools test.", prompt: "PRIVATE_INPUT_MARKER" };
const privateMessage = "PRIVATE_PROVIDER_MESSAGE";
const fixtures = [
  { name: "top-level error", event: { type: "error", code: "server_error", message: privateMessage },
    expected: { kind: "transient", streamEvent: "error", providerErrorCode: "server_error", retryable: true } },
  { name: "nested error", event: { type: "error", error: { type: "server_error", message: privateMessage } },
    expected: { kind: "transient", providerErrorCode: "server_error", retryable: true } },
  { name: "failed response", event: { type: "response.failed", response: { error: { code: "internal_error", message: privateMessage } } },
    expected: { kind: "transient", streamEvent: "response.failed", providerErrorCode: "internal_error", retryable: true } },
  { name: "response.error", event: { type: "response.error", error: { code: "request_timeout", message: privateMessage } },
    expected: { kind: "timeout", streamEvent: "response.error", providerErrorCode: "request_timeout", retryable: true } },
  { name: "context overflow, not transport timeout", event: { type: "error", code: "context_length_exceeded", message: "timeout" },
    expected: { kind: "context_limit", providerErrorCode: "context_length_exceeded", retryable: false } },
  { name: "invalid prompt, not transport timeout", event: { type: "error", code: "invalid_prompt", message: "timeout" },
    expected: { kind: "invalid_request", providerErrorCode: "invalid_prompt", retryable: false } },
  { name: "authentication in completed envelope", event: { type: "response.completed", response: {
    status: "failed", error: { code: "invalid_api_key", message: privateMessage },
  } }, expected: { kind: "authentication", streamEvent: "response.completed", providerErrorCode: "invalid_api_key", retryable: false } },
  { name: "length-limited partial output", event: { type: "response.incomplete", response: {
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
  } }, expected: { kind: "invalid_output", providerErrorCode: "max_output_tokens", retryable: false } },
  { name: "content filter", event: { type: "response.incomplete", response: {
    status: "incomplete", incomplete_details: { reason: "content_filter" },
  } }, expected: { kind: "invalid_request", providerErrorCode: "content_filter", retryable: false } },
  { name: "unknown provider code stays manual", event: { type: "error", code: "PRIVATE_NEW_CODE",
    message: "terminated" }, expected: { kind: "unknown", providerErrorCode: "unrecognized", retryable: false } },
  { name: "unknown uncoded failure stays manual", event: { type: "error", message: privateMessage },
    expected: { kind: "unknown", streamEvent: "error", retryable: false } },
] as const;

function completedResponse(text: string, withUsage = true): Response {
  const item = { type: 'message', id: 'synthetic-message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }] };
  const events = [{ type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      id: 'synthetic-completed', status: 'completed', output: [item],
      ...(withUsage ? { usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25,
        input_tokens_details: { cached_tokens: 6 } } } : {}),
    } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe("Pi SSE failure handling without live inference", () => {
  it('returns only the final verdict when Codex emits commentary before schema-constrained JSON', async () => {
    const items = [
      { type: 'message', id: 'commentary', role: 'assistant', phase: 'commentary', status: 'completed',
        content: [{ type: 'output_text', text: '{"supported":false} Let me reconsider.', annotations: [] }] },
      { type: 'message', id: 'final', role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text: '{"supported":true,"reason":"Существенных ошибок не найдено"}', annotations: [] }] },
    ];
    const events = [...items.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item })),
      { type: 'response.completed', response: { status: 'completed', output: items } }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 }));
    const response = await (await generator(async () => {})).generate({ ...request,
      responseSchema: { name: 'review', schema: { type: 'object' } } }, { operationId: 'synthetic-review' });
    expect(JSON.parse(response.text)).toEqual({ supported: true, reason: 'Существенных ошибок не найдено' });
  });

  it('does not treat commentary-only output as a final answer', async () => {
    const item = { type: 'message', id: 'commentary', role: 'assistant', phase: 'commentary', status: 'completed',
      content: [{ type: 'output_text', text: '{"supported":false,"reason":"Ещё проверяю"}', annotations: [] }] };
    const events = [{ type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { status: 'completed', output: [item] } }];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 }));
    await expect((await generator(async () => {})).generate(request, { operationId: 'no-final' }))
      .rejects.toMatchObject({ metadata: { kind: 'invalid_output' } });
  });

  it.each([true, false])('counts original and repair calls exactly once, repair accepted=%s', async accepted => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(completedResponse('not json'))
      .mockResolvedValueOnce(completedResponse(accepted ? '{"result":"ok"}' : '{"other":"invalid"}'));
    const client = await generator(async () => {});
    const promise = generateStructured(client, { ...request, validator: z.object({ result: z.string() }) },
      { operationId: 'research:00000000-0000-4000-8000-000000000001:queries' }, async () => {});
    if (accepted) expect((await promise).repaired).toBe(true);
    else await expect(promise).rejects.toMatchObject({ metadata: {
      kind: 'invalid_output', outcome: 'rejected', retryable: false, nextRetryAt: null,
    } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(recordUsage).mock.calls.map(([call]) => call);
    expect(calls.map(call => call.stage)).toEqual(['research:queries', 'research:queries:repair']);
    expect(new Set(calls.map(call => call.id)).size).toBe(2);
    for (const call of calls) expect(call).toMatchObject({ outcome: 'completed', usageKnown: true,
      inputTokens: 14, outputTokens: 5, cacheReadTokens: 6, totalTokens: 25, actualBilledCost: null });
    expect(calls[0]?.estimatedCost).not.toBeNull();
    expect(JSON.stringify(calls)).not.toMatch(/PRIVATE_|synthetic-refresh|not json/);
  });

  it('ends after a rogue tool-call generation instead of silently dispatching another model turn', async () => {
    const item = { type: 'function_call', id: 'synthetic-tool', call_id: 'synthetic-call', name: 'unknown_tool', arguments: '{}' };
    const events = [{ type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { status: 'completed', output: [item],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } }];
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200 },
    )).mockResolvedValueOnce(completedResponse('unexpected extra model call'));
    const client = await generator(async () => {});
    await expect(client.generate(request, { operationId: 'rogue-tool' })).rejects.toMatchObject({
      metadata: { kind: 'invalid_output' },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', usageKnown: true,
      inputTokens: 20, outputTokens: 5, totalTokens: 25 }));
  });

  it('retains reported usage on a provider failure without inventing a price', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify({
      type: 'response.failed', response: { status: 'failed', usage: {
        input_tokens: 20, output_tokens: 5, total_tokens: 25,
      }, error: { code: 'server_error', message: 'PRIVATE_PROVIDER_MESSAGE' } },
    })}\n\n`, { status: 200 }));
    const client = await generator(async () => {});
    await expect(client.generate(request, { operationId: 'reported-failure' })).rejects.toBeDefined();
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', usageKnown: true,
      inputTokens: 20, outputTokens: 5, totalTokens: 25, estimatedCost: null, actualBilledCost: null }));
  });

  it('does not treat missing provider usage as SDK default zero usage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(completedResponse('valid text', false));
    const client = await generator(async () => {});
    await client.generate(request, { operationId: 'missing-usage' });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', usageKnown: false,
      inputTokens: null, estimatedCost: null, actualBilledCost: null }));
  });

  it.each(fixtures)("records $name on HTTP 200", async ({ event, expected }) => {
    const body = `data: ${JSON.stringify(event)}\n\n`;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, {
      status: 200, headers: { "content-type": "text/event-stream" },
    }));
    const recorded: ModelFailure[] = [];
    const client = await generator(async failure => { recorded.push(failure); });
    await expect(client.generate(request, { operationId: "synthetic-sse" })).rejects.toMatchObject({
      metadata: { ...expected, status: 200, outcome: "unknown" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(recorded).toHaveLength(1);
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: event.type === 'response.incomplete' ? 'completed' : 'failed',
      usageKnown: false, inputTokens: null, outputTokens: null, estimatedCost: null, actualBilledCost: null }));
    if (recorded[0]?.retryable) {
      expect(Date.parse(recorded[0].nextRetryAt ?? "") - Date.parse(recorded[0].failedAt)).toBeGreaterThanOrEqual(300_000);
    } else {
      expect(recorded[0]?.nextRetryAt).toBeNull();
    }
    expect(JSON.stringify(recorded)).not.toMatch(/PRIVATE_|synthetic-refresh/);
  });

  it("detects EOF before a terminal event through the actual SDK parser", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('data: {"type":"response.created","response":{"id":"synthetic-response"}}\n\n', {
      status: 200,
    }));
    const record = vi.fn().mockResolvedValue(undefined);
    const client = await generator(record);
    await expect(client.generate(request, { operationId: "synthetic-eof" })).rejects.toMatchObject({
      metadata: { kind: "transient", status: 200, outcome: "unknown", transportKind: "stream_eof", retryable: true },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
  });

  it("detects an abruptly terminated body through the actual SDK parser", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new TypeError("terminated")); } });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    const record = vi.fn().mockResolvedValue(undefined);
    const client = await generator(record);
    await expect(client.generate(request, { operationId: "synthetic-terminated" })).rejects.toMatchObject({
      metadata: { kind: "transient", status: 200, transportKind: "stream_terminated", outcome: "unknown", retryable: true },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not resubmit malformed SSE JSON as a transport error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("data: PRIVATE_INVALID_JSON\n\n", { status: 200 }));
    const recorded: ModelFailure[] = [];
    const client = await generator(async failure => { recorded.push(failure); });
    await expect(client.generate(request, { operationId: "synthetic-protocol" })).rejects.toMatchObject({
      metadata: { kind: "invalid_output", transportKind: "stream_protocol_error", retryable: false },
    });
    expect(JSON.stringify(recorded)).not.toContain("PRIVATE_");
  });

  it("preserves status and labels the local deadline independently of an upstream timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>(), { status: 200 }));
    const record = vi.fn().mockResolvedValue(undefined);
    const client = await generator(record, 100);
    await expect(client.generate(request, { operationId: "synthetic-deadline" })).rejects.toMatchObject({
      metadata: { kind: "timeout", transportKind: "local_deadline", status: 200, retryable: true, outcome: "unknown" },
    });
    expect(record).toHaveBeenCalledOnce();
  });

  it('aborts a stalled SDK stream through the caller signal and releases the serial limiter for queued work', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>(), { status: 200 }))
      .mockResolvedValueOnce(completedResponse('Queued work completed.'));
    const record = vi.fn().mockResolvedValue(undefined);
    const client = await generator(record, 1_200_000);
    const stalled = client.generate(request, { operationId: 'synthetic-optional-review', signal: AbortSignal.timeout(100) });
    const rejected = expect(stalled).rejects.toMatchObject({ metadata: { kind: 'cancelled', outcome: 'unknown' } });
    const queued = client.generate(request, { operationId: 'synthetic-next-model' });
    await rejected;
    expect((await queued).text).toBe('Queued work completed.');
    expect(fetch).toHaveBeenCalledTimes(2); expect(record).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledTimes(2);
  });

  it("respects a stream usage reset despite HTTP 200", async () => {
    const reset = Math.ceil((Date.now() + 3_600_000) / 1000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`data: ${JSON.stringify({
      type: "error", error: { code: "usage_limit_reached", message: privateMessage, resets_at: reset },
    })}\n\n`, { status: 200 }));
    const recorded: ModelFailure[] = [];
    const client = await generator(async failure => { recorded.push(failure); });
    await expect(client.generate(request, { operationId: "synthetic-reset", attempt: 20 })).rejects.toMatchObject({
      metadata: { kind: "throttled", providerErrorCode: "usage_limit_reached", status: 200, retryable: true },
    });
    expect(Date.parse(recorded[0]?.nextRetryAt ?? "")).toBeGreaterThanOrEqual(reset * 1000);
  });
});
