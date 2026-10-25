# Processing

- Collect immutable source revisions into durable batches.
- Extract exact source passages in one structured model call.
  Local validation checks coordinates, overlap and complete coverage.
  Save successful extraction once, including empty results.
- Compare each report with every retained eligible story group.
  Bounded, cached chunks preserve full reports and provenance.
  Attach only to the highest-ranked `same` candidate.
  Record other `same` matches as `related`, without extra comparisons.
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

`GROUPING_MAX_PROMPT_BYTES` defaults to 98304; candidates per chunk to 32.
Complete pairs that exceed the byte limit fail rather than lose evidence.
Private inference requires approval or `ALLOW_PRIVATE_INFERENCE=true`.
`NEWS_SUMMARY_MAX_CHARS` defaults to 1000. Headlines allow 180 characters.
Links render separately. Published text stays immutable; matching reports
create cumulative editions with verified same-event ancestry.
Leases serialize processing; checkpoints resume through recovery.
See [manual runs](../../docs/run-now.md) and
[reliability](../../docs/news-reliability.md).
