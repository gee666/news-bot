# Model usage accounting

`100_model_usage.sql` starts accounting. Existing request-attempt logs and cached model results cannot recover historical tokens or costs, so there is no backfill.

Pi, JEV and Ollama clients record one row per dispatched call. `infer` gives each invocation a UUID and persists it after completion or failure. Inserts are idempotent by that UUID, not by operation ID or attempt, since one operation can make several real calls. Application cache hits and preflight failures create no rows. Structured-output validation does not add rows; its original and repair model calls each record their own usage.

Pi uses the SDK's per-request fetch override to identify dispatch and explicitly ends each session after one model turn, including rogue tool-call responses. It accepts token usage only when the provider reports it, not from the SDK's initial zero-filled assistant state. Completed, truncated and refused generation responses count as completed calls even when later application validation rejects them. Transport/provider failures without reported usage keep null tokens and costs. Reported usage on provider failures is retained.

SDK cost components are USD catalog estimates. They are not invoices or Codex OAuth subscription charges. `actualBilledCost` stays null unless a provider supplies an actual billed amount. JEV and Ollama currently provide no cost amounts; self-hosted operating costs are not inferred. JEV's raw input_tokens covers full prepared input, including prefixes. Persisted inputTokens subtracts its cache read/write subsets, matching Pi's exclusive input category. Original JevResult.usage and metrics remain unchanged. Invalid or overlapping counters larger than full input make that call's usage unknown rather than inventing a negative/clamped input. Known input, output, cache read and cache write categories sum to totalTokens. See the linked protocol evidence in tmp/usage-jev-semantics.md. Reasoning tokens are already included in Pi output.

Usage history has no foreign keys to retained source content. Operation IDs and resolved database stage labels remain available after content cleanup. No prompts, outputs, errors or credentials are stored in usage rows.

GET `/api/usage` returns filtered totals, provider/model/stage groups, and UTC hour/day series. Series contain the latest 1000 occupied buckets, with `seriesTruncated` indicating older omitted points; totals still cover the whole filter. GET `/api/usage/calls` returns newest-first paginated details. Both APIs validate filters and project response fields. Cost coverage counts identify partial aggregates. See `tmp/usage-api-contract.md` for response shapes.

Accounting storage failures are reported separately and never replace a successful result or the provider's ModelRequestError/retry metadata. Failed database writes are saved as owner-only JSON in a private outbox. Server startup, periodic recovery and shutdown replay only database inserts with the original call UUID; they never dispatch inference. ON CONFLICT makes ambiguous committed writes safe to replay. Invalid outbox records stay available for inspection and are not inserted.

MODEL_USAGE_OUTBOX_DIR overrides the outbox path, defaulting to usage-outbox beside PI_AUTH_PATH. Compose forwards it with /data/pi/usage-outbox as the default, on the existing persistent Pi volume. MODEL_USAGE_RETRY_MS sets recovery frequency, default 30000, allowed 1000..3600000. Startup verifies owner-only directory/file permissions and filesystem access before listening or starting workers. Logs contain failure labels and call IDs, not paths, connection strings or provider payloads.

GET `/api/runtime` exposes private-storage readiness, pending record count and background replay status without paths, filenames, IDs or queued contents.

A crash before the database write or outbox save can still leave a call unrecorded. If both database and filesystem writes fail, the loss is reported but cannot be recovered. There is no provider billing reconciliation. The API reports recorded usage, not a guaranteed complete invoice.
