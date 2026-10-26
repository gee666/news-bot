# News reliability and recovery

## Collection

Publisher sources retain a bounded discovery backlog, prioritize fresh entries and back off failed reads. Failed attempts consume the article budget. Sources shows backlog use, failed reads, retry times and overflow. A finite backlog cannot recover entries that disappear between polls.

Source settings allow 1 to 50 article attempts, 1 to 1000 backlog entries and a 1 to 720 minute base retry delay. A retry requires a later cutoff. Changing undated-entry policy can recover previously skipped IDs without replaying retained items. Feed link and date settings control whether submission dates and external article links are used. The Hacker News preset opens a draft; it does not alter existing subscriptions.

## Processing

Extraction uses one model call and validates exact ranges, overlap and full source coverage locally. Successful extraction belongs to the immutable revision, including confirmed-empty output. Restarts and profile changes do not repeat it.

Grouping compares every retained eligible group in bounded cached chunks without truncating reports. Each candidate receives `same`, `related` or `unrelated`. Only the highest-ranked `same` candidate receives the report. Extra `same` matches do not create inferred `related` links; no cross-chunk verification requests run. Each stored relation retains only its pair's candidate fingerprints, not a duplicate of the entire catalogue. Related stories stay separate from generation input.

Revision stages share retry receipts across batches. A story has one failure budget in `story-failures.ts`, with one diagnostic per failure and no stage-level retry timer. `requestMaxAttempts` bounds failures; `retryBaseMs` and `retryMaxMs` set exponential backoff. Successful calls and processing checkpoints do not spend attempts. Exhausted units are skipped while healthy siblings and later batches continue.

Story completion checks representative, eligibility, ranking and generation freshness before a guarded update. A lost update fails with `story changed during refresh`, without repeating the checks. Delivery independently checks freshness before sending.

## Generation and delivery

Pi writes Russian news using complete source reports, retained publication history and read research. Fetch byte limits still apply. Origin classification identifies primary sources, not independently verified facts. Relays appear in the secondary-source footer, not as attributed authorities in the news body.

Headlines allow 180 characters. Summaries target 60 to 90 percent of `NEWS_SUMMARY_MAX_CHARS`, which defaults to 1000 and accepts 200 to 2000. Overlong output fails validation rather than being clipped. Source links render separately.

A review follows the draft, with at most one rewrite and re-review. Review failure does not block a valid draft. Any nonempty reviewer reason appears as `Заметки проверяющего`. If optional review or correction fails, the last valid draft keeps a Russian note. Failures before a valid draft use the story retry budget.

Attachment download and decoding failures omit that attachment rather than failing text generation. Partial media selections remain eligible for another preparation attempt. Privacy checks still run before downloads and inference.

Eligibility, minimum score and delivery-safety checks still apply. Published story text and factual sources stay immutable; matching reports create cumulative editions. Unknown Telegram outcomes require reconciliation rather than blind resending.

Activity shows source coverage, retries and historical admission denials. A denial records a past observation, not necessarily a current block. Inspect its time alongside the current queue and publication state.

See [processing](../src/pipeline/README.md) and [manual runs](run-now.md).
