import { z } from "zod";
import { RequestFault, UnsupportedVisionFault } from "./errors.js";
import { ModelHttp, numericHeader, type HttpConfig } from "./http.js";
import { infer, type InferenceOptions, type RequestContext } from "./inference.js";
import { jevTemplates, type JevQuestion, type JevTemplate } from "./templates.js";
import { measureJevContext, requireJevContext } from './jev-context.js';
import type { JevContextBudget } from './jev-budget.js';
import { prepareJevState, referenceInstructions } from './jev-state.js';

import type { ModelImage } from "./images.js";

const probability = z.number().finite().min(0).max(1);
const distribution = z.record(z.string(), probability);
const answerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: distribution, confidence: probability }),
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("score"), score: z.number().finite().nonnegative(),
    probabilities: distribution, confidence: probability, legend: z.record(z.string(), z.string()) }),
]);
const responseSchema = z.object({
  model: z.string().min(1), answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});
export type JevAnswer = z.infer<typeof answerSchema>;

export interface JevMetrics {
  durationMs: number;
  requestId?: string;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  queueDurationMs?: number;
}
export interface JevResult {
  model: string;
  template: JevTemplate;
  promptVersion: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  metrics: JevMetrics;
}
export interface JevConfig extends InferenceOptions {
  baseUrl: string;
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Off until cached/original-order decisions have been compared for the workload. */
  prefixCache?: boolean;
  /** Explicit capacity for providers without a capability endpoint. Never inferred from character ratios. */
  contextTokens?: number;
  framingReserveTokens?: number;
  onMetrics?: (metrics: JevMetrics) => void;
}

export class JevClient {
  private readonly http: ModelHttp;
  private readonly timeoutMs: number;
  constructor(private readonly config: JevConfig) {
    this.timeoutMs = config.timeoutMs ?? 1_200_000;
    if (this.timeoutMs < 1_200_000) throw new Error("JEV requires at least a 1200-second deadline");
    const httpConfig: HttpConfig = { baseUrl: config.baseUrl, timeoutMs: this.timeoutMs,
      ...(config.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: config.connectTimeoutMs }) };
    this.http = new ModelHttp(httpConfig);
  }

  /** The local System One transport has no supported image attachment protocol. */
  readonly supportsImages = false;

  judge(template: JevTemplate, state: unknown, context: RequestContext, images?: readonly ModelImage[]): Promise<JevResult> {
    return infer("jev", this.timeoutMs, context, this.config.recordFailure, async (dispatch) => {
      if (images?.length) throw new UnsupportedVisionFault();
      if (!(typeof state === "string" || (typeof state === "object" && state !== null))
        || !isJson(state)) throw new RequestFault("invalid_request", { outcome: "not_submitted" });
      if (!this.config.apiKey) throw new RequestFault("authentication", { outcome: "not_submitted" });
      const prepared = prepareJevState(template, z.json().parse(state));
      const questions: Record<string, JevQuestion> = Object.fromEntries(Object.entries(jevTemplates[template].questions)
        .map(([key, question]) => [key, { ...question, instructions: question.instructions + (prepared.references ? referenceInstructions : '') }]));
      const override = this.config.contextTokens ?? process.env.JEV_CONTEXT_TOKENS;
      const capacitySchema = z.coerce.number().int().min(512).max(1_000_000);
      let capacity: number;
      let actualModel: string;
      if (override !== undefined) {
        const parsed = capacitySchema.safeParse(override);
        if (!parsed.success) throw new RequestFault('invalid_request', { outcome: 'not_submitted' });
        capacity = parsed.data;
        actualModel = ['autojev', 'jev-latest', 'autojev-27b-q4_k_m'].includes(this.config.model ?? 'jev-latest')
          ? 'autojev-27b-q4_k_m' : this.config.model ?? 'unknown';
      } else {
        const metadata = z.object({ contextTokens: capacitySchema, model: z.string().min(1) }).safeParse(
          await this.http.metadata('/health', AbortSignal.any([dispatch.signal, AbortSignal.timeout(10_000)])));
        if (!metadata.success) throw new RequestFault('invalid_request', { outcome: 'not_submitted' });
        capacity = metadata.data.contextTokens; actualModel = metadata.data.model;
      }
      const reserve = z.coerce.number().int().min(128).max(4096).safeParse(
        this.config.framingReserveTokens ?? process.env.JEV_FRAMING_RESERVE_TOKENS ?? 512);
      if (!reserve.success) throw new RequestFault('invalid_request', { outcome: 'not_submitted' });
      let budget: JevContextBudget;
      try { budget = await measureJevContext(prepared.state, questions, capacity, actualModel, this.config.prefixCache ?? false, reserve.data); }
      catch { throw new RequestFault('invalid_request', { outcome: 'not_submitted' }); }
      requireJevContext(budget);
      const response = await this.http.post("/v1/systemone",
        { model: this.config.model ?? "jev-latest", state: prepared.state, questions },
        { Authorization: `Bearer ${this.config.apiKey}`,
          "X-AutoJev-Prefix-Cache": String(this.config.prefixCache ?? false) }, dispatch);
      const usage = responseSchema.shape.usage.safeParse(
        z.object({ usage: z.unknown() }).safeParse(response.value).data?.usage);
      const cacheRead = response.headers.has('x-autojev-cached-tokens')
        ? numericHeader(response.headers, 'x-autojev-cached-tokens') : 0;
      const cacheWrite = response.headers.has('x-autojev-cache-write-tokens')
        ? numericHeader(response.headers, 'x-autojev-cache-write-tokens') : 0;
      const responseModel = z.object({ model: z.string().min(1) }).safeParse(response.value).data?.model;
      // The provider reports full input; prefix read/write counts are subsets, not extra tokens.
      if (usage.success && cacheRead !== undefined && cacheWrite !== undefined
        && Number.isSafeInteger(cacheRead) && Number.isSafeInteger(cacheWrite)
        && cacheRead + cacheWrite <= usage.data.input_tokens) {
        dispatch.completed({ input: usage.data.input_tokens - cacheRead - cacheWrite, output: usage.data.output_tokens,
          cacheRead, cacheWrite, totalTokens: usage.data.input_tokens + usage.data.output_tokens }, responseModel);
      }
      const parsed = responseSchema.safeParse(response.value);
      if (!parsed.success) throw new RequestFault("invalid_output");
      validateAnswers(template, parsed.data.answers);
      const requestId = response.headers.get("x-typesafe-request-id");
      const cachedTokens = numericHeader(response.headers, "x-autojev-cached-tokens");
      const cacheWriteTokens = numericHeader(response.headers, "x-autojev-cache-write-tokens");
      const queueDurationMs = numericHeader(response.headers, "x-autojev-queue-milliseconds");
      const metrics: JevMetrics = {
        durationMs: response.durationMs,
        ...(requestId === null ? {} : { requestId }),
        ...(cachedTokens === undefined ? {} : { cachedTokens }),
        ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
        ...(queueDurationMs === undefined ? {} : { queueDurationMs }),
      };
      this.config.onMetrics?.(metrics);
      return { ...parsed.data, template, promptVersion: jevTemplates[template].version, metrics };
    }, this.config.requestMaxAttempts, { provider: 'jev', model: this.config.model ?? 'jev-latest',
      recordUsage: this.config.recordUsage });
  }

  test(context: RequestContext): Promise<JevResult> {
    return this.judge("story_count", { message: { text: "A software vendor released a security patch today." } }, context);
  }
  close(): Promise<void> { return this.http.close(); }
}

function validateAnswers(template: JevTemplate, answers: Record<string, JevAnswer>): void {
  const questions: Record<string, JevQuestion> = jevTemplates[template].questions;
  if (Object.keys(answers).length !== Object.keys(questions).length) throw new RequestFault("invalid_output");
  for (const [name, question] of Object.entries(questions)) {
    const answer = answers[name];
    if (!answer || answer.type !== question.type) throw new RequestFault("invalid_output");
    if (question.type === "choice" && answer.type === "choice") {
      if (!Object.hasOwn(question.criteria, answer.choice)
        || !sameKeys(Object.keys(question.criteria), Object.keys(answer.probabilities))) {
        throw new RequestFault("invalid_output");
      }
    }
    if (question.type === "score" && answer.type === "score") {
      const indices = question.criteria.map((_, index) => String(index));
      if (answer.score > indices.length - 1 || !sameKeys(indices, Object.keys(answer.probabilities))
        || !sameKeys(indices, Object.keys(answer.legend))) throw new RequestFault("invalid_output");
    }
    if (answer.type !== "noul") {
      const total = Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0);
      if (Math.abs(total - 1) > 0.02) throw new RequestFault("invalid_output");
    }
  }
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}
function isJson(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isJson);
  }
  return false;
}

/** AutoJev score indices start at zero, not one. */
export function interestScore(answer: JevAnswer): number {
  if (answer.type !== "score" || answer.score > 9) throw new Error("Expected ten-level interest score");
  return Math.round(answer.score) + 1;
}
