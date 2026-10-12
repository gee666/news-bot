import { codexUsage, sdkUsage, type CallUsage } from './usage.js';
import type { Usage } from "@earendil-works/pi-ai";
import { createAgentSession, createExtensionRuntime, SessionManager, SettingsManager,
  type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { classifyProviderError, faultFromError, providerRetryTime, RequestFault, retryTime } from "./errors.js";
import { providerDiagnostics } from "./provider-diagnostics.js";
import { isObject, piStreamFailure } from "./pi-failure.js";
import { infer, type InferenceOptions, type RequestContext } from "./inference.js";
import { CODEX_MODEL, CODEX_PROVIDER, type PiRuntime } from "./pi-runtime.js";

export interface ResponseSchema { name: string; schema: Record<string, unknown> }
export interface PiRequest {
  systemPrompt: string;
  prompt: string;
  responseSchema?: ResponseSchema;
}
export interface PiConfig extends InferenceOptions {
  runtime: PiRuntime;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  /** Live-verified with Pi 0.99.1 and gpt-6-luna; disable for an unverified model. */
  nativeSchema?: boolean;
}
export interface PiResult {
  text: string;
  model: string;
  provider: string;
  usage: Usage;
  durationMs: number;
  nativeSchema: boolean;
}

export function isolatedResources(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function commentary(signature: string | undefined): boolean {
  if (!signature?.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(signature);
    return isObject(parsed) && parsed.v === 1 && parsed.phase === 'commentary';
  } catch { return false; }
}

export class PiGenerator {
  constructor(private readonly config: PiConfig) {}

  get supportsNativeSchema(): boolean { return this.config.nativeSchema ?? true; }

  generate(request: PiRequest, context: RequestContext): Promise<PiResult> {
    const timeoutMs = this.config.timeoutMs ?? 1_200_000;
    return infer("pi", timeoutMs, context, this.config.recordFailure, async (dispatch) => {
      if (!request.systemPrompt.trim() || !request.prompt.trim()) {
        throw new RequestFault("invalid_request", { outcome: "not_submitted" });
      }
      const provider = this.config.provider ?? CODEX_PROVIDER;
      const modelId = this.config.model ?? CODEX_MODEL;
      if (provider !== CODEX_PROVIDER) throw new RequestFault("invalid_request", { outcome: "not_submitted" });
      const runtime = this.config.runtime.modelRuntime;
      const credentials = await runtime.listCredentials({ signal: dispatch.signal });
      if (!credentials.some((info) => info.providerId === provider && info.type === "oauth")) {
        throw new RequestFault("authentication", { outcome: "not_submitted" });
      }
      const model = runtime.getModel(provider, modelId);
      if (!model) throw new RequestFault("model_unavailable", { outcome: "not_submitted" });
      const cwd = this.config.runtime.agentDir;
      const { session } = await createAgentSession({
        cwd, agentDir: cwd, modelRuntime: runtime, model, thinkingLevel: "off",
        resourceLoader: isolatedResources(request.systemPrompt),
        tools: [], noTools: "all", customTools: [],
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({
          compaction: { enabled: false }, cacheWarming: "off", transport: "sse",
          httpIdleTimeoutMs: timeoutMs,
          retry: { enabled: false, maxRetries: 0,
            provider: { maxRetries: 0, timeoutMs, maxRetryDelayMs: 0 } },
        }),
      });
      // A rogue tool-call response must not trigger another paid turn in this no-tools session.
      session.agent.finishTurn = () => ({ action: 'end' });
      const stream = session.agent.streamFunction;
      session.agent.streamFunction = (model, input, options) => stream(model, input, { ...options,
        fetch: (url, init) => {
          dispatch.submitted();
          return globalThis.fetch(url, init);
        },
      });
      let status: number | undefined;
      let retryAt: number | undefined;
      let requestId: string | undefined;
      let providerFailure: RequestFault | undefined;
      let reportedUsage: CallUsage | undefined;
      let responseModel: string | undefined;
      session.agent.onResponse = (response) => {
        status = response.status;
        const headers = new Headers(response.headers);
        retryAt = retryTime(headers);
        requestId = headers.get("x-request-id") ?? undefined;
      };
      session.agent.onProviderStreamEvent = (event) => {
        reportedUsage = codexUsage(event) ?? reportedUsage;
        const response = isObject(event) && isObject(event.response) ? event.response : undefined;
        if (typeof response?.model === 'string' && response.model.trim()) responseModel = response.model;
        if (reportedUsage) dispatch.reportedUsage(reportedUsage, responseModel);
        if (isObject(event) && ['response.completed', 'response.done', 'response.incomplete'].includes(String(event.type))
          && (response?.status === 'completed' || response?.status === 'incomplete')) {
          dispatch.completed(reportedUsage, responseModel);
        }
        // HTTP 200 acknowledges SSE headers, not successful model completion.
        providerFailure ??= piStreamFailure(event, status);
      };
      const nativeSchema = Boolean((this.config.nativeSchema ?? true) && request.responseSchema);
      session.agent.onPayload = (payload) => {
        if (!isObject(payload)) throw new RequestFault("invalid_request");
        if ("tools" in payload && Array.isArray(payload.tools) && payload.tools.length) {
          throw new RequestFault("invalid_request", { outcome: "not_submitted" });
        }
        if (!nativeSchema || !request.responseSchema) return payload;
        return { ...payload, text: {
          ...(isObject(payload.text) ? payload.text : {}),
          format: { type: "json_schema", name: request.responseSchema.name, strict: true,
            schema: request.responseSchema.schema },
        } };
      };
      const abort = () => { session.agent.abort(); };
      dispatch.signal.addEventListener("abort", abort, { once: true });
      try {
        dispatch.signal.throwIfAborted();
        await session.prompt(request.prompt, { expandPromptTemplates: false });
        const assistant = session.messages.findLast((message) => message.role === "assistant");
        if (assistant?.role === 'assistant' && ['stop', 'length', 'toolUse'].includes(assistant.stopReason)) {
          dispatch.completed(reportedUsage ? sdkUsage(assistant.usage) ?? reportedUsage : undefined,
            assistant.responseModel ?? responseModel ?? assistant.model);
        }
        if (providerFailure) throw providerFailure;
        if (!assistant || assistant.role !== "assistant") throw new RequestFault("invalid_output");
        if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
          const message = assistant.errorMessage || "";
          const kind = classifyProviderError(message, status);
          retryAt ??= providerRetryTime(message);
          throw new RequestFault(kind, { ...providerDiagnostics(message), outcome: "unknown" });
        }
        if (assistant.stopReason !== "stop" || assistant.content.some((block) => block.type === "toolCall")) {
          throw new RequestFault("invalid_output");
        }
        // Codex can send commentary before its schema-constrained final answer.
        const text = assistant.content.filter((block) => block.type === "text")
          .filter((block) => !commentary(block.textSignature)).map((block) => block.text).join("");
        if (!text.trim()) throw new RequestFault("invalid_output");
        return { text, model: modelId, provider, usage: assistant.usage,
          durationMs: Date.now() - dispatch.startedAt, nativeSchema };
      } catch (error) {
        const fault = providerFailure ?? faultFromError(error);
        const requestRetryAt = fault.detail.retryAt ?? retryAt;
        // Include accepted HTTP status even when the SDK throws rather than returning an assistant error.
        throw new RequestFault(fault.kind, { ...fault.detail,
          ...(status === undefined ? {} : { status, ...(status >= 200 && status < 300 ? { outcome: "unknown" as const } : {}) }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(requestRetryAt === undefined ? {} : { retryAt: requestRetryAt }),
        });
      } finally {
        dispatch.signal.removeEventListener("abort", abort);
        session.dispose();
      }
    }, this.config.requestMaxAttempts, { provider: this.config.provider ?? CODEX_PROVIDER,
      model: this.config.model ?? CODEX_MODEL, recordUsage: this.config.recordUsage });
  }

  test(context: RequestContext): Promise<PiResult> {
    return this.generate({ systemPrompt: "Reply in Russian with one short factual sentence. No tools.",
      prompt: "Synthetic connection test: a software vendor released a security patch today." }, context);
  }
}

