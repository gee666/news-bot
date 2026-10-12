# Shared JEV context guard

Every `JevClient.judge()` call prepares a lossless state and measures the complete question before classifier dispatch. This covers extraction, count, eligibility, interest, duplicate/matching/consolidation, representative, integrity, split and link templates. Embedding chunking is unrelated.

The local AutoJev `/health` endpoint provides the actual `contextTokens` and model name, including while the model is unloaded. There is no tokenizer endpoint on that front. JEV never reads a private backend key or bypasses the public bridge.

For `autojev-27b-q4_k_m`, the guard loads the matching public Qwen35 BPE vocabulary/merges/special tokens/classifier labels from `model-data/autojev-qwen35-tokenizer.json.gz`. It checks the artifact hash and uses `@huggingface/tokenizers`. Provider state formatting, instructions, option descriptions/codes and prefix-cache order are included. A separate framing reserve covers the serving chat wrapper and boundary overhead. This is prompt budgeting, not inference usage.

The normal capacity comes from the provider. For a provider without that capability, an explicit client `contextTokens` or `JEV_CONTEXT_TOKENS` is required. `framingReserveTokens`/`JEV_FRAMING_RESERVE_TOKENS` defaults to 512, allowed 128 to 4096. Unknown tokenizer families use a conservative UTF8 byte bound, not a characters/4 guess. Such a refusal means the request cannot be certified by that bound, not that its facts are invalid.

Dispatch requires `promptTokens + reservedTokens < contextTokens`. Refusal occurs before `/v1/systemone`, with `kind=context_limit`, `outcome=not_submitted` and safe numeric `jevContextBudget` metadata. Capability reads are not classifier calls. No usage row is created for a preflight refusal. No requested/preflight token count becomes billed/evaluated usage.

## Lossless packing

Duplicate comparisons replace mention/candidate aggregate copies only when each is mechanically verified as the unique-text concatenation of its corresponding complete report group. Every separate source URL, distribution link and report remains present.

Long strings repeated anywhere in a state are stored once in a text table. Exact `$jevTextRef` markers replace repeated values; every question receives explicit decoding instructions. The full original field structure can be reconstructed. Reserved-marker collisions disable packing. This covers representative story/left/right/reports and repeated extraction/link contexts without changing the excerpts or losing qualifiers.

No substring clipping, summarization, guessed event identity or synthesized verdict occurs. Judgment caches use `:lossless-context-v1` to separate the wire protocol from prior requests; durable semantic prompt versions and already-completed stages remain unchanged.

## Unresolved decisions

A failed budget does not mean `different`, `background`, `rejected`, low interest, coherence or a successful merge. Optional comparison callers must record an unresolved decision and preserve affected dedupe/publication safety while allowing unrelated work. Required checks need bounded complete evaluation/review, not a fabricated result. A conservative preflight refusal is distinct from a positive provider rejection and must not be treated as proof of permanent item invalidity.

The adapter does not automatically buy Pi work or blindly split a whole-event comparator. A bounded explicit exact evaluator can resolve work later under its own approval and accounting. Changing the tokenizer/model requires a verified artifact update and regression checks; a model-name alias alone is not editorial acceptance.
