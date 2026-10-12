import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PiGenerator, isolatedResources, type PiResult } from "./pi.js";
import { openPiRuntime } from "./pi-runtime.js";
import { generateStructured } from "./structured.js";
import { RequestFault } from "./errors.js";

afterEach(() => vi.restoreAllMocks());
const responseSchema = { name: "test_result", schema: { type: "object", properties: {
  result: { type: "string" } }, required: ["result"], additionalProperties: false } };

function assistant(text: string): AssistantMessage {
  return { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6-luna",
    timestamp: Date.now(), content: [{ type: "text", text }], stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function result(text: string): PiResult {
  const message = assistant(text);
  return { text, model: message.model, provider: message.provider, usage: message.usage,
    durationMs: 1, nativeSchema: false };
}

describe("isolated Pi generation", () => {
  it("has explicit empty discovery resources", () => {
    const resources = isolatedResources("Only the task prompt.");
    expect(resources.getExtensions().extensions).toEqual([]);
    expect(resources.getSkills().skills).toEqual([]);
    expect(resources.getPrompts().prompts).toEqual([]);
    expect(resources.getAgentsFiles().agentsFiles).toEqual([]);
    expect(resources.getAppendSystemPrompt()).toEqual([]);
    expect(resources.getSystemPrompt()).toBe("Only the task prompt.");
  });

  it("uses fresh SDK sessions, zero tools and native schema without a local input character guard", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () =>
      ({ type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3600_000 }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const payloads: unknown[] = [];
    let userCounts = 0;
    const stream = vi.spyOn(runtime, "streamSimple").mockImplementation((_model, context, options) => {
      expect(options?.maxRetries).toBe(0);
      expect(options?.transport).toBe("sse");
      expect(options?.timeoutMs).toBe(300_000);
      const messages = context.messages;
      expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
      userCounts++;
      const output = new AssistantMessageEventStream();
      void Promise.resolve(options?.onPayload?.({ model: "gpt-6-luna", tools: [], text: {} }, _model))
        .then((payload) => {
          payloads.push(payload);
          const message = assistant('{"result":"ok"}');
          output.push({ type: "done", reason: "stop", message });
          output.end();
        });
      return output;
    });
    const generator = new PiGenerator({ runtime: { modelRuntime: runtime, authPath: resolve("tmp/fake-auth/auth.json"),
      agentDir: resolve("tmp/fake-auth") }, recordFailure: async () => {} });
    const request = { systemPrompt: "Generate a factual result.", prompt: "Synthetic test.", responseSchema };
    expect((await generator.generate(request, { operationId: "one" })).nativeSchema).toBe(true);
    await generator.generate({ ...request, prompt: 'x'.repeat(3_000_000) }, { operationId: "two" });
    expect(stream).toHaveBeenCalledTimes(2);
    expect(userCounts).toBe(2);
    expect(payloads[0]).toMatchObject({ tools: [], text: { format: {
      type: "json_schema", strict: true, name: "test_result" } } });
  });

  it("applies configured retry limits to generation and connection tests", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false,
    });
    // No provider/network call. The SDK's authentication boundary reports a transient failure.
    vi.spyOn(runtime, "listCredentials").mockRejectedValue(new RequestFault("transient"));
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    const generator = new PiGenerator({ runtime: { modelRuntime: runtime,
      authPath: resolve("tmp/fake-auth/auth.json"), agentDir: resolve("tmp/fake-auth") },
      requestMaxAttempts: 10, recordFailure });
    await expect(generator.generate({ systemPrompt: "Synthetic", prompt: "Synthetic" },
      { operationId: "generation", attempt: 5 }))
      .rejects.toMatchObject({ metadata: { retryable: true } });
    await expect(generator.test({ operationId: "connection", attempt: 10 }))
      .rejects.toMatchObject({ metadata: { retryable: false, nextRetryAt: null } });
    expect(recordFailure).toHaveBeenCalledTimes(2);
  });

  it("delegates serialized OAuth token refresh to Pi", async () => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai-codex", async () => ({
      type: "oauth", access: "expired-fake", refresh: "old-fake", expires: 0,
    }));
    const runtime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
    const oauth = runtime.getProvider("openai-codex")?.auth.oauth;
    if (!oauth) throw new Error("Missing built-in Codex OAuth");
    const refresh = vi.spyOn(oauth, "refresh").mockResolvedValue({
      type: "oauth", access: "new-fake", refresh: "rotated-fake", expires: Date.now() + 3600_000,
    });
    const auth = await Promise.all([runtime.getAuth("openai-codex"), runtime.getAuth("openai-codex")]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(auth.every((value) => value?.auth.apiKey === "new-fake")).toBe(true);
    expect((await credentials.read("openai-codex"))?.type).toBe("oauth");
  });

  it("requires app-owned protected auth paths", async () => {
    await expect(openPiRuntime(resolve(homedir(), ".pi/agent/auth.json"))).rejects.toThrow("application-owned");
    await expect(openPiRuntime("relative/auth.json")).rejects.toThrow("absolute");
    await mkdir("tmp", { recursive: true });
    const directory = await mkdtemp(resolve("tmp/pi-permissions-"));
    try {
      await chmod(directory, 0o755);
      await expect(openPiRuntime(resolve(directory, "auth.json"))).rejects.toThrow("private");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("repairs JSON once and validates exact stable ID membership", async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(result('{"items":[{"id":"wrong"}]}'))
      .mockResolvedValueOnce(result('{"items":[{"id":"one"}]}'));
    const repaired = await generateStructured({ generate }, {
      systemPrompt: "Map IDs", prompt: "ID one", responseSchema,
      validator: z.object({ items: z.array(z.object({ id: z.string() })) }),
      validate: (value) => value.items.length === 1 && value.items[0]?.id === "one",
    }, { operationId: "map" }, async () => {});
    expect(repaired.repaired).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1]?.[1]).toMatchObject({ operationId: "map:repair" });
  });

  it("persists invalid output after the only repair fails", async () => {
    const generate = vi.fn().mockResolvedValue(result("not JSON"));
    const recordFailure = vi.fn().mockResolvedValue(undefined);
    await expect(generateStructured({ generate }, {
      systemPrompt: "Return JSON", prompt: "Synthetic",
      validator: z.object({ id: z.string() }),
    }, { operationId: "invalid" }, recordFailure))
      .rejects.toMatchObject({ metadata: { kind: "invalid_output", outcome: "rejected", retryable: false } });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(recordFailure).toHaveBeenCalledOnce();
  });
});
