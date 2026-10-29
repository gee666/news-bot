# Processing

- Collect immutable source revisions into durable batches.
- Extract exact source passages in one structured model call.
  Local validation checks coordinates, overlap and complete coverage.
  Save successful extraction once, including empty results.
- Compare each report with every retained eligible story group using JEV.
  Cached pair decisions preserve full reports and provenance.
  Attach only to the highest-ranked `same` candidate.
  Leave additional `same` matches unrecorded, never relabel them as `related`.
  Related stories stay separate and never contribute generation material.
- Classify item links together, then read and assess relevant documents.
  Link relevance and primary origin do not prove factual verification.
- Check story coherence, select a representative, assess eligibility,
  rank interest and refresh embeddings. JEV context overflow uses Pi
  with the same criteria and complete input.
- Classify primary origins. Search for missing primaries only at interest
  >=5 and at or above the configured research threshold.
- Write Russian news from source reports, retained history and research.
  Review it, with at most one rewrite and re-review.
  Review failure does not block a valid draft. Nonempty notes are shown.
- Check completion postconditions and generation freshness once before
  a guarded update. Enqueue completed current stories for publishing.

Revision stages share saved results and a retry budget across batches.
Stories use only the `story-failures.ts` marker, not stage retry receipts.
`requestMaxAttempts`, `retryBaseMs` and `retryMaxMs` bound failures.
Checkpoints and successful calls do not consume attempts.
Healthy siblings continue while failed units wait or exhaust their budget.

Grouping uses JEV directly, once per uncached incoming/candidate pair, with full
reports, source URLs and publication times. Completed pairs survive checkpoints
and candidate reordering. JEV context limits fail without truncation or a Pi fallback.
Private inference requires approval or `ALLOW_PRIVATE_INFERENCE=true`.
`NEWS_SUMMARY_MAX_CHARS` defaults to 1000. Headlines allow 180 characters.
Links render separately. Published text stays immutable; matching reports
create cumulative editions with verified same-event ancestry.
Leases serialize processing; checkpoints resume through recovery.
See [manual runs](../../docs/run-now.md) and
[reliability](../../docs/news-reliability.md).

Automatic work prefers the newest due collection cutoff. `last_served_at` only
breaks equal-cutoff ties; recovery does not rotate through stale whole batches.
Automatic unextracted revisions and unassigned reports outside
`collectionWindowHours` retire with `outside_collection_window`. Active manual
pins and committed extraction receipts stay intact.

A source connector's saved cooldown does not delay already collected inputs.
Ready revisions or mentions run before another unit's future retry deadline.
After collected work finishes, the batch waits for its remaining connector or
stage receipts. Connector failures still stop at the configured attempt limit;
checkpoint deferrals do not consume failure attempts.

Extraction serves untouched revisions before previously served work. There is no
eager whole-batch matching pass ahead of extraction. Long comparisons checkpoint
with cached pair decisions intact and pause only their stage for
`max(retryBaseMs, processingSliceMs())`, two minutes with defaults. This pause
charges no failure attempt and gives other fresh inputs a turn.
