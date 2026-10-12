# Processing

The processor handles each current collected revision independently. Successful extraction is final for that revision, including confirmed-empty results. A restart reuses its saved output without inference or failure-attempt increments.

Each item proceeds from extraction to matching and story preparation before the next item starts. A failed item or story does not stop siblings. Pi, JEV and embedding failures use the same exponential backoff, configured by `retryBaseMs`, `retryMaxMs` and `requestMaxAttempts`. Exhausted units are marked failed and skipped. No preview, approval or provider-health probe is required.

Waiting batches have their own deadlines. The processor selects the newest due batch first, then drains older batches as recent intake finishes. Saved unassigned mentions reach matching before new extraction; assigned mentions are not embedded or matched again. Collection continues independently. The pipeline lease serializes processing, not retry waits. Matching checks the five nearest candidates by default, configurable through `matchCandidateLimit`.

Batch model/profile settings remain fixed. Migration `192_recent_intake.sql` reduces only the old default matching shortlist from twenty to five for automatic unfinished batches, preserving other configured limits. An older batch does not regenerate a completed, non-stale shared story whose profile/model versions supersede its snapshot, or overwrite that story's newer ready event. Its unfinished story stages are skipped. Identical extraction replay also preserves completed item status; changed extracted mentions still reopen item work.

`PROCESSING_SLICE_MS` defaults to 120000, with an allowed range of 1000 to 3600000. A checkpoint releases the lease and resumes saved progress on the 15-second recovery tick. Completed receipts remain reusable after the slice deadline. A checkpoint is not a failure. Inputs are acknowledged after extraction, matching and reconciliation, before story generation. Completion requires a finished link stage and settled mention assignments; unstarted pending inputs cannot be marked complete, and their batch remains open.

Consolidation and source-link decisions retain successful results. Failed selections retry automatically and do not withhold otherwise valid stories. Story failures retry independently during processing or digest refresh.

Each digest processing phase gets its own `PROCESSING_SLICE_MS` slice and releases the processor lease before the next phase. Checkpoints stop new work without cancelling current requests. Summary review, rewrite and re-review each have an abort deadline of one slice; the required writer retains its full configured timeout and input. Legacy notices are refreshed first, followed by stories with the newest collected reports. Automatic digest recovery postpones historical consolidation and source-link enrichment while intake is unfinished; explicit manual digests still run these phases. Ready stories publish even when a sweep yields or the processor is busy; their per-story freshness and delivery checks still apply. Partial sweeps publish first, then save the existing retry deferral for the recovery tick.

Migration `190_automatic_processing.sql` makes legacy parked work retryable, restores quarantined mention associations, retires approval records and resets old attempt accounting. It preserves successful outputs, collected content and request audits. Apply it through the normal migration runner, not ad-hoc changes to the live database.

The Activity tab's manual run remains available. It shares the same unit retries and saved cooldowns. See [manual runs](../../docs/run-now.md).
