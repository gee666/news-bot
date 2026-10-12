# Collect & publish now

Open the Activity tab and use **Collect & publish now**. The confirmation authorizes a small real publication run using saved settings. It does not save or change your settings, interest profile, cron expressions, or publication score threshold.

Defaults are 3 sources, 20 input entries, 5 stories to prepare, and 5 new posts. You can lower them before starting. Hard limits are 10 sources, 50 entries, 10 stories, and 10 new posts. Existing posts for affected stories can be edited separately and do not consume the new-post limit. Their exact publication/snapshot targets are pinned durably. Cumulative counts survive pauses and configuration changes and exclude unrelated later edits.

The input limit bounds fetch work, not just publication selection. The run pins enabled, active sources in least-recently-updated order and splits the entry budget across them. A publisher still obeys its smaller configured article limit and normal unseen-first order. Telegram reads the newest entries only. A capped Telegram read leaves its cursor unchanged. Publisher progress records only visited entries. Omitted entries remain available to normal collection inside the normal rolling window. Unchanged content does not become a new revision.

The collected-only option skips source fetching. It selects fresh current revisions already pending in collection batches, but only when no processing stage has ever started for that revision. A six-hour wait on a different revision does not block these untouched inputs. Previously dispatched revisions are excluded. Selection atomically moves only those pending membership rows to the manual batch and records their original batch/revision pairs for audit. The original processor cannot dispatch them again during a manual wait or after completion. Source batches, cursors, unselected membership, provider deadlines and stage records stay unchanged.

The run processes its own bounded batch through the existing extractor, matcher, consolidation, source-link assessment, story preparation, and publisher. Source-link intake is limited to this batch, with retained stories used as comparison context. The story cap limits distinct stories selected for preparation, including existing affected stories. It does not limit the number of events an input may contain. Affected stories beyond this cap can still be prepared by ordinary refresh work, with the same automatic unit retries, but retain manual-origin ownership and cannot become automatic new sends merely because of that refresh. Each accepted selected story publishes at its committed ready boundary instead of waiting for the whole batch. The publication receipt grows incrementally within the original cap. The publication cap limits newly prepared rows for this run, not arbitrary rows already waiting in publication history. All final generation, source-quality, eligibility, destination, bot ownership, and freshness checks still apply.

The button stays disabled while its operation is queued, running, or waiting. The operation card shows collection, processing and publication stages, input outcomes, selected stories, new posts, edited posts, and withheld or waiting reasons. Reason counts cover different units and may overlap. `publication_selection_limit` counts completed SQL-selection candidates beyond the cap before final generation and delivery admission. Sources not selected and entries not inspected are not counted as rejected news. Zero new posts is a valid result.

## Waits and recovery

There is no digest-schedule or batch-completion wait after an accepted selected story is ready. If publishing is paused while eligible ready work remains, the durable job waits and retries its publication checkpoint after five seconds without collecting or regenerating again. Processing can still take minutes, especially while a model starts or research fetches pages. A busy pipeline retries after two seconds. Saved unit retry deadlines and Telegram cooldowns are not cleared by the button. A terminal connector failure is reported as a partial result, not replaced by a broad collection sweep. Telegram collection honors its account-wide saved cooldown. A retry after a transient failure uses the same source selection and capped per-source fetch budget.

The job is durable. Browser reloads do not cancel it. Shutdown stops dispatch at the next checkpoint. Restarted running operations wait five minutes before resuming their saved batch and publication selection. Publication rows and interrupted request receipts carry their own cooldown, so startup maintenance cannot race reconciliation ahead of it. An unknown send or edit requires reconciliation, never a blind resend. A missing send requires operator review. Changing the destination or bot identity after selection ends the run with a reason instead of moving its saved publication IDs to another channel.

Ordinary schedules and publication maintenance remain enabled. They can do their own work while this run waits. The displayed counts and limits apply only to this operation, not to all channel traffic.

Model usage operation IDs begin with `run_now:<operation UUID>:` for this run. The original stage or story operation ID follows that prefix. Stage labels and normal request receipts keep their original IDs. The prefix also survives deferred usage writes.

## API

Submit with the existing same-origin session and CSRF token:

```http
POST /api/operations
Content-Type: application/json
X-CSRF-Token: <session token>

{"kind":"run_now","options":{"mode":"collect","sourceLimit":1,"inputLimit":2,"storyLimit":1,"publicationLimit":1}}
```

`options` and its fields are optional. Modes are `collect` and `collected`. Values must be whole JSON numbers in the limits above. Unknown fields, limits on unrelated operations, and missing CSRF are rejected. The response is HTTP 202 with an operation ID and polling location. Use `GET /api/operations/:id` or the operation list. `runNow` contains the saved options and progress. Duplicate starts return the active operation with its original limits.

See [scheduled batch publication and manual ownership](immediate-publishing.md). Migration `140_story_publication_ready.sql` adds the ready journal without backfilling completed history.

Manual and scheduled processing share the pipeline lease. Migration `190_automatic_processing.sql` lets batches wait independently without blocking later work. Apply migrations before starting the new build. Do not edit applied migrations.
