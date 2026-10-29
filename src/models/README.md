# Model adapters

Import from `src/models/index.ts`. Node 24 is required. Pi dependencies track `latest`; the npm lockfile records validated versions. The [Pi updater](../../docs/pi-updates.md) checks SDK compatibility before accepting updates. Direct dependencies used here are `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `undici` 7, `zod` 4 and `@huggingface/tokenizers@0.2.0`. The tokenizer and packaged public metadata support the [shared JEV context guard](jev-context.md).

## Host integration

Every client config requires `recordFailure: (failure: ModelFailure) => Promise<void>`. Commit the failure to the stage or test record in PostgreSQL. Adapters await that write before throwing `ModelRequestError`, whose `metadata` is safe to store and show. Storage failures are reported separately and do not replace provider retry metadata. Do not log arbitrary provider errors or authentication runtime objects. Usage writes use a private recoverable outbox on database failure; replay never dispatches inference. See ../usage/README.md.

Every inference method takes `RequestContext`:
```ts
interface RequestContext {
  operationId: string; // Stable stage/test record ID, not source text.
  attempt?: number;   // Starts at 1. Restore/increment from the saved record.
  stage?: string;     // Optional stable task label for calls without a database stage.
  signal?: AbortSignal;
}
```

News-source origin classification is separate from factual verification: an original tweet or report can be primary without proving personal experimental involvement, and unreadable origin links remain references. Summary prompts prohibit attribution to secondary relays.

There are no immediate automatic retries. The processing loop resumes eligible failed work at `nextRetryAt`; authentication, model, input/context and invalid-output failures need correction. Transport/server and timeout errors stop at the client's `requestMaxAttempts`, default three. Pipeline and settings-page clients receive the saved setting; UI restart recovery uses it too. Throttling uses the same attempt cap and respects a later provider retry deadline. Timeouts and recognized interrupted Pi streams with unknown outcomes wait at least five minutes before a later retry. Deadline duration starts after acquiring the shared `inferenceLimiter`, not while waiting locally. The same gate covers generation and settings-page test calls from every client instance.

HTTP clients use a 10-second connection deadline and separate total/idle request deadlines. JEV defaults to 20 minutes and rejects settings below its documented minimum. Ollama defaults to 10 minutes. Pi defaults to five minutes, configurable through `piTimeoutMs`. Migration 194 shortens only the former twenty-minute default for automatic work; custom deadlines and manual batch snapshots remain unchanged. Pipeline coherence, representative selection, news eligibility and interest judgments fall back to Pi on JEV context-limit errors, using the same criteria and full input. Pi receipts retain their actual model key; no calibrated JEV probabilities are claimed. Close replaced HTTP clients with `close()`.

## Exports

```ts
openPiRuntime(authPath: string): Promise<PiRuntime>
CODEX_PROVIDER = "openai-codex"
CODEX_MODEL = "gpt-6-luna"

new PiGenerator(config: PiConfig)
  generate(request: PiRequest, context: RequestContext): Promise<PiResult>
  test(context: RequestContext): Promise<PiResult>

interface PiRequest {
  systemPrompt: string;
  prompt: string;
  responseSchema?: { name: string; schema: Record<string, unknown> };
  images?: readonly { data: string; mimeType: string }[]; // Raw base64, not data URLs.
}
interface PiConfig {
  runtime: PiRuntime;
  recordFailure: FailureRecorder;
  provider?: string; // V1 accepts only openai-codex OAuth.
  model?: string;    // Defaults to gpt-6-luna. No fallback substitution.
  timeoutMs?: number;
  requestMaxAttempts?: number; // Defaults to 3, including throttling.
  nativeSchema?: boolean;
}
```

Images are ordered Pi SDK `ImageContent` attachments via `session.prompt(text, { images })`, not text embedded in a prompt. PNG, JPEG, WebP and GIF MIME types and base64 syntax are validated before dispatch. A text-only model is rejected with a clear `invalid_request`, `not_submitted` failure. The adapter also rejects attachments omitted by SDK decoding/resizing before any provider call. Text-only requests remain unchanged. Structured generation preserves the same attachments on its isolated repair request.

Each request creates and disposes a new direct SDK session with in-memory history/settings, no active/custom tools, and an explicit resource loader returning no extensions, skills, instructions, templates or themes. File discovery, catalog files/network refresh, compaction, cache warming and provider/agent retries are disabled. The only system content is the task prompt and Pi's explicit SDK working-directory section.

The auth path must be absolute, in a private application-owned directory. Symlink auth files, group/world permissions and development Pi auth directories are rejected. Pi owns OAuth exchange, locked refresh and credential storage. Use a protected volume, never the running development Pi's writable auth file.

`PiResult` contains `text`, `model`, `provider`, Pi `usage`, `durationMs`, and `nativeSchema`. Native JSON Schema is applied via Pi's documented payload hook to Responses `text.format`, with `strict: true`. It defaults on when a schema is supplied, verified against gpt-6-luna. Disable it for unverified model choices. Codex commentary blocks are excluded from `PiResult.text`; only final or legacy unphased text reaches JSON validation. Commentary can contain provisional JSON followed by reasoning, even when the final answer satisfies the native schema.

```ts
generateStructured<T>(
  generator: TextGenerator,
  request: StructuredRequest<T>, // PiRequest + validator: z.ZodType<T>, validate?: (value: T) => boolean
  context: RequestContext,
  recordFailure: FailureRecorder,
): Promise<{ value: T; generation: PiResult; repaired: boolean }>
```

This validates JSON and optional cross-record checks and allows one isolated repair request. Extraction and research use it. Summary generation calls `generate()` directly with a native schema and validates locally, without structured repair turns. Luna has no local input character guard.

```ts
new PiOAuth(runtime: PiRuntime["modelRuntime"], loginTimeoutMs?: number)
  start(): Promise<OAuthStatus>
  status(): Promise<OAuthStatus>
  finish(id: string, redirectUrl: string): Promise<OAuthStatus>
  cancel(id?: string): Promise<void>
```

Start returns a login ID and provider authorization URL. Render that link, accept a pasted complete redirect URL, and poll status after finish. Finish rejects code-only URLs or absent state; Pi checks state against its PKCE flow. Pi's loopback callback can also finish directly. Login expires after 15 minutes. No tokens or callback URLs appear in status. After restart, credentials remain but an unfinished browser flow must restart.

`OAuthStatus` contains `provider`, `connected`, and nullable `login` with `id`, `phase`, `expiresAt`, optional `authorizationUrl` and safe `message`. Phases are starting, awaiting_redirect, exchanging, complete, failed and cancelled. Connected means a stored OAuth credential exists, not a successful live inference.

```ts
new JevClient(config: JevConfig)
  readonly supportsImages = false
  judge(template: JevTemplate, state: unknown, context: RequestContext, images?: readonly ModelImage[]): Promise<JevResult>
  test(context: RequestContext): Promise<JevResult>
  close(): Promise<void>

new EmbeddingClient(config: EmbeddingConfig)
  embed(texts: readonly string[], context: RequestContext): Promise<EmbeddingResult>
  test(context: RequestContext): Promise<EmbeddingResult>
  close(): Promise<void>
```

Both configs take `baseUrl`, `recordFailure`, optional `model`, `timeoutMs`, `connectTimeoutMs`, `requestMaxAttempts`. JEV also requires `apiKey` and accepts `prefixCache`, `onMetrics`. Embeddings accept `dimensions`, default 4096.

JEV template names and state fields. The pipeline uses JEV for coherence, representative selection, eligibility and interest. Extraction uses Pi with exact source coordinates and a review. Grouping calls JEV's `duplicate` template directly for each uncached pair and retains pair receipts and checkpoints. It does not fall back to Pi. Link assessment uses one Pi call across all candidates.

| Template | State | Answer |
| --- | --- | --- |
| story_count | message.text | count: choice none, 1 through 20, more |
| link_relevance | story, link, anchor, surroundingText | relevance: relevant, irrelevant, uncertain |
| duplicate | mention, candidate | relation: same, related, unrelated |
| media_identity | detailed left/right visual evidence from Pi, correspondences, differences, limitations | relation: same, different |
| interest | story, interestProfile | interest: score index 0 through 9 |
| representative | story, left, right | best: left or right |

Instructions, option ordering and question serialization are frozen. Candidate text and the interest profile stay in state. Group ready work by template in the host processing loop. Each input is one HTTP request, not a server batch job. `jevTemplates` exposes prompt versions. `interestScore(answer)` rounds the weighted zero-based index and adds one to produce a 1–10 application score.

`JevResult` contains `model`, `template`, `promptVersion`, validated `answers`, raw provider token `usage` and `metrics`. Persisted usage normalizes full input by subtracting cache read/write subsets; the returned usage/metrics do not change. Inconsistent counters leave accounting usage unknown. Metrics contain dispatch duration, request ID, cached tokens, cache-write tokens and queue milliseconds when available. Prefix mode is explicit in every request and defaults off. Small synthetic checks passed, but they do not establish accuracy on real Telegram messages.

Ollama receives `POST /api/embed`, `options.num_ctx: 2048`, `truncate: false`. Vector count, dimensions, finite values, nonzero content and returned model are checked. No truncation or output-dimension reduction is applied. `EmbeddingResult` contains `model`, `vectors`, `dimensions`, `durationMs`, optional `promptTokens`, and `inputVersion: "plain-text-ctx2048-v1"`. Cache keys must include model, dimensions, input version and input. The host owns judgment/embedding caches and corpus re-embedding.

## Media identity integration

```ts
import { compareMediaIdentity, JevClient } from "./models/index.js";

const result = await compareMediaIdentity(
  await generationClient(settings), // Existing TextGenerator factory in the host.
  jev,                            // JevClient with its normal config and recorders.
  [leftImage, rightImage],         // Exactly two ModelImage values, in this order.
  context,                        // Stable per-pair operationId, attempt and signal.
  recordGenerationFailure,
);
// result.decision: "same" | "different" | "unresolved"
```

`ModelImage` is exported as `{ data: string; mimeType: string }`. `PiRequest.images` also enables direct multimodal `TextGenerator.generate()` calls without this comparator.

`compareMediaIdentity(generator, jev, images, context, recordFailure)` first sends both image attachments to Pi for detailed structured visual evidence, not a final verdict. It includes subjects, composition, distinctive features, readable text, chart/screenshot details, correspondences, differences, possible transformations and limitations. JEV then judges `media_identity` from that evidence. Identity means reuse of underlying visual content, allowing incidental crops, captions and recompression, not merely a shared topic or event.

The result retains `evidence`, `evidenceVersion`, `generation` and `repaired`. When sufficient, it also has `judgment: JevResult` and the final JEV `same`/`different` decision. Unreadable or insufficient evidence returns `decision: "unresolved"` and `judgment: null` without a JEV call. Treat that as no identity decision, never as proof of difference. Provider, cancellation, context-budget and invalid-output errors propagate, never become an identity verdict. Invalid evidence gets the existing one isolated Pi repair with both attachments.

Pi uses `operationId + ":vision"`, its repair uses `":vision:repair"`, and JEV uses `":jev"`; stage labels get matching suffixes. Attempt and signal are preserved. Both adapters keep their standard failure/usage accounting. The host must use a stable ID for each distinct image pair, store the receipts, and manage caching/restarts. Re-running the helper after a JEV failure also repeats the Pi call. To resume without paying for evidence again, save the returned validated evidence before dispatching JEV through a host-owned staged workflow using `generateStructured()` and `judge("media_identity", evidenceState, context)`. Include `MEDIA_IDENTITY_EVIDENCE_VERSION`, `jevTemplates.media_identity.version`, both image identities and the model choices in cache keys. The helper itself has no durable checkpoint.

### Verified transport limits

The configured bridge's `/health` identifies `autojev-27b-q4_k_m` with a 12288-token context; `/v1/models` describes it as local AutoJev, with JEV names as compatibility aliases. Neither advertises image support. The installed Pi SDK's `api/system-one-shared.js` explicitly rejects `context.images` and sends only `{ state, questions }` through System One. Its separate `openai-decisions.js` supports images, but that is a different API and is not evidence that AutoJev supports them. The Pi Responses adapter supports actual `input_image` data URLs, and `AgentSession` exposes `PromptOptions.images`.

The bridge's OpenAPI/dashboard routes require dashboard authentication, so its internal backend implementation could not be inspected here. Direct AutoJev vision support remains unverified and unsupported by this adapter. Do not infer it from the model family, send base64 inside JSON state, or add guessed image fields that a server might ignore. `jev.judge(..., context, nonemptyImages)` fails locally with a recorded, non-retryable `invalid_request`, `outcome: "not_submitted"`, explaining that vision-capable Pi extraction is required. The supported path is Pi vision followed by JEV text-evidence judgment, not a claim that JEV saw the pixels. No live image-comparison accuracy test has been performed.

## Failure record

`ModelFailure` contains `operationId`, `service`, `kind`, safe `message`, `attempt`, `failedAt`, nullable `nextRetryAt`, `retryable`, `outcome`, `durationMs`, optional HTTP `status` and `requestId`, and optional allowlisted `providerErrorCode`, `transportKind`, `streamEvent`. Unrecognized structured codes are labeled `unrecognized`, never copied. Arbitrary provider messages, event bodies, token deltas and payloads are not persisted. The sole prose exception is `providerContextLimit.message`, validated against an anchored numeric-only context-size rejection grammar of at most 200 characters. Its bounded `requestTokens` and `contextTokens` retain exact input-capacity evidence, not evaluated/billed usage. Unknown prose, extra fields and inconsistent counters are dropped. AutoJev's `exceed_context_size_error` maps to `context_limit`; authentication/model/service errors remain separate. A bare `invalid_request` is not proof of item-local rejection. All pipeline/UI request-attempt recorders use `failureResponseMetadata` to revalidate these labels before storing JSON. Services are jev, embedding and pi. Outcomes are not_submitted, rejected and unknown. Completed replies rejected by local structured validation use rejected; interrupted streams stay unknown. Failure kinds are authentication, model_unavailable, invalid_request, context_limit, throttled, transient, timeout, cancelled, invalid_output and unknown.

HTTP 200 only acknowledges SSE headers. Pi captures top-level `error` / `response.error`, `response.failed`, and unsuccessful terminal envelopes. Known server codes, SDK EOF messages and abrupt transport termination are recoverable under the configured attempt cap; authentication, request/context, filtered/truncated output and malformed SSE JSON remain correction-required. Opaque errors are not made retryable merely because a request took a long time. Local deadline/cancellation labels stay distinct from upstream timeouts and preserve any observed HTTP status.

Pi receives the configured `timeoutMs` and no provider retries. The adapter's dispatch timer bounds total completion. There is no 900-second override in this adapter. An upstream/proxy termination can occur earlier; elapsed time alone cannot identify it.

## Live evidence and remaining checks

Synthetic adapter checks passed through localhost JEV/Ollama and actual Codex OAuth. Safe reports are in `tmp/models-live-*-report.jsonl`. gpt-6-luna produced Russian prose and native-schema output without repair, including a probe asking it to violate the schema. JEV returned valid response shapes for every template and reused 533 prefix tokens on consecutive story-count calls. Ollama returned 4096-dimensional vectors and rejected an over-context input with HTTP 400 instead of truncating.

Browser login completion by the user and container-to-host connectivity remain deployment checks. Unit tests cover UI flow, cancellation, secret-safe status, built-in locked refresh, direct SDK isolation/schema injection, shared dispatch, metadata persistence and response validation. Persisted retry scheduling, result caching, corpus re-embedding, stage grouping and endpoint/UI wiring belong to the host.

Usage-outbox writes retain their call ID and a durable `_delivery` attempt/deadline. Recovery backs off using the saved startup retry settings and stops after `requestMaxAttempts`, including the original write. Exhausted or malformed files are retained with a `.json.failed` suffix for inspection, not automatically replayed. Legacy records without delivery metadata are due immediately. Storage recovery never reruns inference.
