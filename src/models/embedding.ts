import { z } from "zod";
import { RequestFault } from "./errors.js";
import { ModelHttp } from "./http.js";
import { infer, type InferenceOptions, type RequestContext } from "./inference.js";

const responseSchema = z.object({
  model: z.string().min(1),
  embeddings: z.array(z.array(z.number().finite()).nonempty()).nonempty(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
});
export interface EmbeddingConfig extends InferenceOptions {
  baseUrl: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  connectTimeoutMs?: number;
}
export interface EmbeddingResult {
  model: string;
  vectors: number[][];
  dimensions: number;
  durationMs: number;
  promptTokens?: number;
  inputVersion: "plain-text-ctx2048-v1";
}

export class EmbeddingClient {
  private readonly http: ModelHttp;
  private readonly timeoutMs: number;
  constructor(private readonly config: EmbeddingConfig) {
    this.timeoutMs = config.timeoutMs ?? 600_000;
    this.http = new ModelHttp({ baseUrl: config.baseUrl, timeoutMs: this.timeoutMs,
      ...(config.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.connectTimeoutMs }) });
  }

  embed(texts: readonly string[], context: RequestContext): Promise<EmbeddingResult> {
    return infer("embedding", this.timeoutMs, context, this.config.recordFailure, async (dispatch) => {
      if (!texts.length || texts.some((text) => !text.trim())) {
        throw new RequestFault("invalid_request", { outcome: "not_submitted" });
      }
      const model = this.config.model ?? "qwen3-embedding:latest";
      const response = await this.http.post("/api/embed",
        { model, input: texts, options: { num_ctx: 2048 }, truncate: false }, {}, dispatch);
      const usage = z.object({ prompt_eval_count: z.number().int().nonnegative() }).safeParse(response.value);
      if (usage.success) dispatch.completed({ input: usage.data.prompt_eval_count, output: 0,
        cacheRead: 0, cacheWrite: 0, totalTokens: usage.data.prompt_eval_count });
      const parsed = responseSchema.safeParse(response.value);
      if (!parsed.success) throw new RequestFault("invalid_output");
      const dimensions = this.config.dimensions ?? 4096;
      const vectors = parsed.data.embeddings;
      if (parsed.data.model !== model || vectors.length !== texts.length
        || vectors.some((vector) => vector.length !== dimensions || vector.every((value) => value === 0))) {
        throw new RequestFault("invalid_output");
      }
      return { model: parsed.data.model, vectors, dimensions,
        durationMs: response.durationMs, inputVersion: "plain-text-ctx2048-v1",
        ...(parsed.data.prompt_eval_count === undefined ? {} : { promptTokens: parsed.data.prompt_eval_count }) };
    }, this.config.requestMaxAttempts, { provider: 'ollama', model: this.config.model ?? 'qwen3-embedding:latest',
      recordUsage: this.config.recordUsage });
  }

  test(context: RequestContext): Promise<EmbeddingResult> {
    return this.embed(["A software vendor released a security patch today."], context);
  }
  close(): Promise<void> { return this.http.close(); }
}
