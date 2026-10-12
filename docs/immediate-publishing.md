# Scheduled batch publishing

Each accepted current story creates a durable publication-ready event when its completion transaction commits. Ordinary events wait for digest selection. The default digest schedule is `0 */3 * * *`, every three hours in the saved timezone. No button is needed for scheduled publishing. Refresh & publish digest now runs the same pipeline on demand; Collect & publish now remains a separate bounded immediate run.

Ready does not mean merely extracted. Eligibility, ranking, generation, evidence and source checks must be current before story completion. The publisher checks versions, automatic story retry state, score threshold and current generation, then applies source and freshness checks. Failed or stale stories cannot send. Ready-event selection runs no model generation and fetches no source pages. Story refresh and source-only link enrichment share one bounded processing sweep and processor lease. A yielded sweep or busy processor does not block already-current ready events. The digest publishes those events before saving its checkpoint retry deadline. Database outages can still fail the turn.

New-post selection comes only from ready events, not a sweep of completed unpublished history. Migration `140_story_publication_ready.sql` deliberately has no backfill. `digestCron` schedules refresh and batch publication. Each selection invocation captures all pending ready events and score-qualified withheld events in one fixed query, with no 20-story cap. Events arriving during selection wait for a later digest. Delivery retries do not select them. Story failures retry with backoff and stop after exhausting their budget. New collected input can start fresh work. Old link-only notices regenerate through normal refresh without approval. Successful current refresh/recovery completion also creates its first ready event when no journal row exists. Stable historical rows are not scanned or backfilled merely because this capability is installed. See [automatic processing retries](../src/pipeline/README.md).

## Timing and pause

Recommended saved settings are:

```json
{"collectionCron":"0 5,9,13,17,21 * * *","digestCron":"0 */3 * * *","timezone":"Europe/Berlin"}
```

That collects at 05:00, 09:00, 13:00, 17:00 and 21:00 Berlin local time. Europe/Berlin uses CEST in summer and CET in winter. The morning run is 03:00 UTC in summer and 04:00 UTC in winter. These hours avoid the ambiguous or missing 02:00 hour at DST transitions. Starting collection at 05:00 gives processing an hour before the 06:00 digest, but collection, model startup and research can take longer. Digests run at 00:00, 03:00, 06:00, 09:00, 12:00, 15:00, 18:00 and 21:00 local time. Ready stories wait for a digest; unresolved processing backlog does not block their selection.

The defaults changed for new installations only. Existing saved cron expressions, timezone, publishing flag and interest profile are not rewritten. The timezone controls collection, digest and cleanup cron jobs. An operator must approve and apply the recommendation to an existing installation. Restoring scheduled selection does not rewrite that installation's saved digest schedule.

`publishingEnabled=false` pauses new sends and edits. Ordinary accepted ready events remain pending until a digest runs with publishing enabled and the bot verified. Previously authorized delivery can resume on maintenance ticks. Collection and processing still run.

`PUBLICATION_READY_INTERVAL_MS` controls the delivery maintenance interval, from 1000 to 60000 milliseconds, default 5000. Compose forwards it. Maintenance resumes prepared sends, uncertain-outcome reconciliation, already-staged edits and authorized replacement deletions. It never consumes fresh ready events or stages their corrections. Busy publication leases, Telegram cooldowns and unknown-outcome reconciliation can delay delivery. They are not bypassed. Unknown sends and edits reuse the existing durable receipts and reconciliation rules, never blind retries.

A below-threshold ready event is reconsidered on the next digest when the score threshold is lowered enough. A failed, expired, source-stale or legacy-held event needs a valid new completion event through the existing processing/repair rules. Selection does not regenerate it.

## Manual-run boundaries

Collect & publish now keeps its saved source, input, story and new-post limits, including the default five-new-post cap. Each accepted selected story invokes scoped publication after its stage and completion transactions commit, before processing the next story. The publication lease is acquired only at this boundary, not held through collection or paid model stages. Publisher holders never acquire the processor lease, so this does not recursively acquire it or create a lock cycle.

Manual publication selection appends newly ready IDs to one durable receipt, within the originally saved limit. Destination and bot identity remain bound. The receipt preserves previous IDs and exact edit targets. Changing a later caller's limit cannot add slots. Existing posts can be edited separately, with immutable snapshot targets and separate counts. Manual prepared rows pin bot ownership before their first send.

All affected manual-origin stories receive durable ownership, including stories beyond the preparation or publication cap. General refresh cannot turn those unselected stories into automatic new sends. The ownership keeps an immutable input fingerprint boundary and survives cleanup of the original manual batch. Older retained manual scopes without a journal are protected lazily when their unchanged reports complete, without backfilling automatic publication events. Policy, parser, cache and display changes cannot release it. A genuinely new current non-manual report, with new owned text or a new source item, can authorize ordinary processing and publication again. Current corrections to already-published manual-origin stories can use digest ready-event selection after the manual operation settles, but that path never selects a new post.

A paused manual job with eligible ready work stays waiting with its original scope and cap. It retries the publication checkpoint after five seconds without collecting or regenerating again. Provider and unknown-delivery waits retain their longer saved deadlines. Manual jobs with no eligible ready work can finish with zero posts and reasons.

Ordinary background traffic may continue while a manual job waits. A run's cap applies to its newly selected publication IDs, not all messages in the channel. Previously authorized publication maintenance is not a new selection.

## Progress and recovery

Activity shows ready-event counts and reasons from `GET /api/status.readyPublications`. Pending events await digest selection. Handed to delivery means the event has been consumed by the existing tracked publication lifecycle, not necessarily that Telegram has acknowledged it. Publication status counts below show the delivery outcome. Withheld events show the reason. Manual scope protected is ownership, not a count of future sends.

Story completion and enqueue commit together. Publication preparation precedes acknowledgment, with a token check so selection cannot acknowledge a newer completion event by mistake. A later digest repeats preparation after a restart or failed acknowledgment safely: publication uniqueness and immutable edit snapshots prevent another send or another desired edit for the same event. The existing publication lease serializes manual and automatic senders.

