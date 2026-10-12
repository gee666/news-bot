import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordUsage } from './usage.js';
import { z } from "zod";
import { EmbeddingClient } from "./embedding.js";
import { failureResponseMetadata, ModelRequestError, type ModelFailure } from "./errors.js";
import { JevClient, interestScore } from "./jev.js";
import { endpoint } from "./http.js";
import { jevTemplates } from "./templates.js";

const cleanups: Array<() => Promise<void>> = [];
vi.mock('./usage.js', async importOriginal => ({
  ...await importOriginal<typeof import('./usage.js')>(), recordUsage: vi.fn(async () => {}),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ contextTokens: 12288, model: 'autojev-27b-q4_k_m' })); return;
    }
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test port");
  cleanups.push(async () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${address.port}`;
}
async function body(req: IncomingMessage): Promise<unknown> {
  req.setEncoding("utf8");
  let text = "";
  for await (const part of req) text += String(part);
  const value: unknown = JSON.parse(text);
  return value;
}
function countResponse(choice = "1", inputTokens = 42, outputTokens = 0): unknown {
  const probabilities = Object.fromEntries(Object.keys(jevTemplates.story_count.questions.count.criteria)
    .map((key) => [key, key === choice ? 1 : 0]));
  return { model: "autojev-27b-q4_k_m", usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    answers: { count: { type: "choice", choice, probabilities, confidence: 1 } } };
}

describe("model HTTP adapters", () => {
  it("sends stable question prefixes with changing state and captures cache headers", async () => {
    const sent: unknown[] = [];
    const baseUrl = await serve((req, res) => {
      expect(req.headers["authorization"]).toBe("Bearer test-key");
      expect(req.headers["x-autojev-prefix-cache"]).toBe("true");
      void body(req).then((value) => {
        sent.push(value);
        res.writeHead(200, { "Content-Type": "application/json", "X-AutoJev-Cached-Tokens": "40",
          "X-AutoJev-Cache-Write-Tokens": "10", "X-AutoJev-Queue-Milliseconds": "12",
          "X-TypeSafe-Request-Id": "request-1" });
        res.end(JSON.stringify(countResponse('1', 100, 5)));
      });
    });
    const client = new JevClient({ baseUrl, apiKey: "test-key", prefixCache: true, recordFailure: async () => {} });
    cleanups.push(() => client.close());
    const result = await client.judge("story_count", { message: { text: "A release." } }, { operationId: "one" });
    await client.judge("story_count", { message: { text: "Another release." } }, { operationId: "two" });
    const schema = z.array(z.object({ questions: z.unknown(), state: z.unknown() }));
    const requests = schema.parse(sent);
    expect(requests[0]?.questions).toEqual(requests[1]?.questions);
    expect(requests[0]?.state).not.toEqual(requests[1]?.state);
    expect(result.metrics).toMatchObject({ cachedTokens: 40, cacheWriteTokens: 10,
      queueDurationMs: 12, requestId: "request-1" });
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 5 });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    for (const [call] of vi.mocked(recordUsage).mock.calls) {
      expect(call).toMatchObject({ inputTokens: 50, outputTokens: 5, cacheReadTokens: 40,
        cacheWriteTokens: 10, totalTokens: 105, usageKnown: true });
      expect((call.inputTokens ?? 0) + (call.outputTokens ?? 0) + (call.cacheReadTokens ?? 0)
        + (call.cacheWriteTokens ?? 0)).toBe(call.totalTokens);
    }
  });

  it.each(['101', '1.5', '-1', 'bad', 'Infinity'])('does not fabricate input totals for invalid cache counter %s', async cached => {
    const baseUrl = await serve((_, res) => {
      res.setHeader('X-AutoJev-Cached-Tokens', cached);
      res.end(JSON.stringify(countResponse('1', 100, 5)));
    });
    const client = new JevClient({ baseUrl, apiKey: 'test-key', recordFailure: async () => {} });
    cleanups.push(() => client.close());
    await client.test({ operationId: 'invalid-cache-counters' });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', usageKnown: false,
      inputTokens: null, cacheReadTokens: null, totalTokens: null }));
  });

  it("persists throttling and rejects without secret/body leaks or immediate resubmission", async () => {
    let calls = 0;
    const failures: ModelFailure[] = [];
    const baseUrl = await serve((_, res) => {
      calls++;
      res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "3600",
        "X-TypeSafe-Request-Id": "request-throttled" });
      res.end(JSON.stringify({ error: { message: "rate limit private-payload" } }));
    });
    const client = new JevClient({ baseUrl, apiKey: "test-key", recordFailure: async (failure) => { failures.push(failure); } });
    cleanups.push(() => client.close());
    await expect(client.test({ operationId: "throttled" })).rejects.toBeInstanceOf(ModelRequestError);
    expect(calls).toBe(1);
    expect(failures[0]).toMatchObject({ kind: "throttled", status: 429, requestId: "request-throttled",
      retryable: true, outcome: "rejected" });
    expect(JSON.stringify(failures)).not.toContain("private-payload");
    expect(Date.parse(failures[0]?.nextRetryAt ?? "") - Date.parse(failures[0]?.failedAt ?? ""))
      .toBeGreaterThan(3_500_000);
  });

  it.each(["jev", "embedding"] as const)("applies the configured retry cap to %s calls and tests", async (service) => {
    let calls = 0;
    const failures: ModelFailure[] = [];
    const baseUrl = await serve((_, res) => {
      calls++;
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "service unavailable" } }));
    });
    const config = { baseUrl, requestMaxAttempts: 10,
      recordFailure: async (failure: ModelFailure) => { failures.push(failure); } };
    const client = service === "jev" ? new JevClient({ ...config, apiKey: "test-key" })
      : new EmbeddingClient(config);
    cleanups.push(() => client.close());
    for (const attempt of [5, 9, 10]) {
      await expect(client.test({ operationId: "retry-" + service, attempt }))
        .rejects.toMatchObject({ metadata: { kind: "transient", retryable: attempt < 10 } });
    }
    expect(calls).toBe(3);
    expect(recordUsage).toHaveBeenCalledTimes(3);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', usageKnown: false,
      inputTokens: null, actualBilledCost: null, estimatedCost: null }));
    expect(failures.map((failure) => failure.retryable)).toEqual([true, true, false]);
    expect(failures[2]?.nextRetryAt).toBeNull();
  });

  it('does not count HTTP 200 headers as completion when the body is invalid', async () => {
    const baseUrl = await serve((_, res) => res.end('PRIVATE_INVALID_JSON'));
    const client = new JevClient({ baseUrl, apiKey: 'test-key', recordFailure: async () => {} });
    cleanups.push(() => client.close());
    await expect(client.test({ operationId: 'invalid-body' })).rejects.toMatchObject({
      metadata: { kind: 'invalid_output', outcome: 'unknown' },
    });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', usageKnown: false,
      inputTokens: null, estimatedCost: null, actualBilledCost: null }));
    expect(JSON.stringify(vi.mocked(recordUsage).mock.calls)).not.toContain('PRIVATE_');
  });

  it.each([
    { status: 400, type: 'exceed_context_size_error', kind: 'context_limit', numeric: true },
    { status: 400, type: 'unsupported_parameter', kind: 'invalid_request', numeric: false },
    { status: 401, type: 'exceed_context_size_error', kind: 'authentication', numeric: false },
    { status: 404, type: 'exceed_context_size_error', kind: 'model_unavailable', numeric: false },
    { status: 503, type: 'service_unavailable', kind: 'transient', numeric: false },
  ])('classifies HTTP $status/$type without promoting systemic errors to input quarantine', async ({ status, type, kind, numeric }) => {
    const message = 'request (13327 tokens) exceeds the available context size (12288 tokens), try increasing it';
    const failures: ModelFailure[] = [];
    const baseUrl = await serve((_, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: status, type, message, input: 'PRIVATE_ARTICLE', key: 'PRIVATE_KEY' } }));
    });
    const client = new JevClient({ baseUrl, apiKey: 'test-key', recordFailure: async failure => { failures.push(failure); } });
    cleanups.push(() => client.close());
    await expect(client.test({ operationId: 'jev-context-regression' })).rejects.toMatchObject({ metadata: { kind, status } });
    const failure = failures[0];
    expect(failure).toBeDefined();
    if (!failure) throw new Error('Missing recorded failure');
    expect(failure.providerContextLimit).toEqual(numeric ? { requestTokens: 13327, contextTokens: 12288, message } : undefined);
    expect(JSON.stringify(failureResponseMetadata(failure))).not.toContain('PRIVATE_');
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', usageKnown: false,
      inputTokens: null, totalTokens: null, estimatedCost: null, actualBilledCost: null }));
  });

  it('recognizes a plain FastAPI context detail but never stores arbitrary detail text', async () => {
    const failures: ModelFailure[] = [];
    const baseUrl = await serve((_, res) => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'input is too long for the context size PRIVATE_ARTICLE' }));
    });
    const client = new JevClient({ baseUrl, apiKey: 'test-key', recordFailure: async failure => { failures.push(failure); } });
    cleanups.push(() => client.close());
    await expect(client.test({ operationId: 'jev-fastapi-detail' })).rejects.toMatchObject({ metadata: { kind: 'context_limit' } });
    expect(JSON.stringify(failures)).not.toContain('PRIVATE_');
    expect(failures[0]?.providerContextLimit).toBeUndefined();
  });

  it('refuses a complete irreducible oversized prompt before classifier dispatch with safe budget diagnostics and no usage row', async () => {
    let classifierCalls = 0;
    const failures: ModelFailure[] = [];
    const baseUrl = await serve((_, res) => { classifierCalls++; res.end(JSON.stringify(countResponse())); });
    const client = new JevClient({ baseUrl, apiKey: 'test-key', recordFailure: async failure => { failures.push(failure); } });
    cleanups.push(() => client.close());
    const state = { story: 'irreducible input0123456789 '.repeat(10000) };
    await expect(client.judge('interest', state, { operationId: 'context-preflight' })).rejects.toMatchObject({
      metadata: { kind: 'context_limit', outcome: 'not_submitted', jevContextBudget: { method: 'autojev_qwen35', contextTokens: 12288 } },
    });
    expect(classifierCalls).toBe(0);
    expect(recordUsage).not.toHaveBeenCalled();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.providerContextLimit).toBeUndefined();
    expect(JSON.stringify(failures)).not.toContain('irreducible input');
    expect(state.story).toBe('irreducible input0123456789 '.repeat(10000));
  });

  it("rejects unknown JEV choices", async () => {
    const baseUrl = await serve((_, res) => res.end(JSON.stringify(countResponse("alien"))));
    const client = new JevClient({ baseUrl, apiKey: "test-key", recordFailure: async () => {} });
    cleanups.push(() => client.close());
    await expect(client.test({ operationId: "invalid" })).rejects.toMatchObject({ metadata: { kind: "invalid_output" } });
    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', usageKnown: true,
      provider: 'jev', model: 'autojev-27b-q4_k_m', inputTokens: 42, outputTokens: 0, estimatedCost: null }));
  });

  it("uses Ollama context 2048 with no truncation and validates vector dimensions", async () => {
    const sent: unknown[] = [];
    const baseUrl = await serve((req, res) => {
      void body(req).then((value) => {
        sent.push(value);
        res.end(JSON.stringify({ model: "qwen3-embedding:latest", embeddings: [[0.2, 0.8]], prompt_eval_count: 7 }));
      });
    });
    const client = new EmbeddingClient({ baseUrl, dimensions: 2, recordFailure: async () => {} });
    cleanups.push(() => client.close());
    expect(await client.embed(["Story"], { operationId: "embed" })).toMatchObject({ dimensions: 2, promptTokens: 7 });
    expect(sent[0]).toMatchObject({ options: { num_ctx: 2048 }, truncate: false, input: ["Story"] });
    const mismatched = new EmbeddingClient({ baseUrl, dimensions: 3, recordFailure: async () => {} });
    cleanups.push(() => mismatched.close());
    await expect(mismatched.embed(["Story"], { operationId: "bad-dimensions" }))
      .rejects.toMatchObject({ metadata: { kind: "invalid_output" } });
    expect(recordUsage).toHaveBeenCalledTimes(2);
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'completed', usageKnown: true,
      provider: 'ollama', inputTokens: 7, outputTokens: 0, totalTokens: 7, estimatedCost: null, actualBilledCost: null }));
  });

  it("uses the same gate across separate clients and test calls", async () => {
    let active = 0;
    let maximum = 0;
    const baseUrl = await serve((req, res) => {
      active++;
      maximum = Math.max(maximum, active);
      setTimeout(() => {
        active--;
        res.end(JSON.stringify(req.url === "/api/embed"
          ? { model: "qwen3-embedding:latest", embeddings: [[1, 0]] } : countResponse()));
      }, 10);
    });
    const jev = new JevClient({ baseUrl, apiKey: "test-key", recordFailure: async () => {} });
    const embedding = new EmbeddingClient({ baseUrl, dimensions: 2, recordFailure: async () => {} });
    cleanups.push(() => jev.close(), () => embedding.close());
    await Promise.all([jev.test({ operationId: "test-jev" }), embedding.test({ operationId: "test-embedding" })]);
    expect(maximum).toBe(1);
  });

  it("rejects deadlines below JEV's server recommendation and unsafe URL credentials", () => {
    expect(() => new JevClient({ baseUrl: "http://localhost", apiKey: "", timeoutMs: 1199_000,
      recordFailure: async () => {} })).toThrow("1200");
    expect(() => endpoint("https://user:secret@example.org", "/api/embed")).toThrow("credentials");
    expect(interestScore({ type: "score", score: 6.4, confidence: 1, probabilities: {}, legend: {} })).toBe(7);
  });
});
