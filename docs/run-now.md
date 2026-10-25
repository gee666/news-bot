# Collect and publish now

Use **Collect & publish now** in Activity to authorize a bounded real publication run with saved settings. It does not change settings, schedules, the interest profile or the publication threshold.

| Limit | Default | Maximum |
| --- | --- | --- |
| Sources | 3 | 10 |
| Input entries | 20 | 50 |
| Stories to prepare | 5 | 10 |
| New posts | 5 | 10 |

Collection pins enabled active sources in least-recently-updated order and divides the entry budget among them. Publisher sources retain their configured smaller article limit. Telegram reads newest entries; a capped read does not advance its cursor. Omitted entries remain available to normal collection within its rolling window.

The collected-only mode skips fetching. It takes fresh current revisions from pending collection batches only if no stage has started for them. It atomically transfers selected membership rows into the manual batch. Unselected work, source cursors and existing retry deadlines stay unchanged.

The run processes its batch through extraction, whole-catalogue grouping, link assessment and story preparation. The story cap includes existing affected stories, not just new ones. It does not cap events per input. Unselected affected stories may refresh normally but keep manual ownership and cannot become automatic new sends.

Each accepted selected story can publish at its committed ready boundary without waiting for batch completion or the digest schedule. The new-post cap applies only to this run's newly prepared publication rows. Updates to pinned existing posts are counted separately. Eligibility, score, source quality, freshness, destination and bot-ownership checks still apply. Zero new posts is valid.

## Waiting and recovery

Activity shows stages, outcomes, selected stories, new posts, updates and reasons. Reason counts can overlap. Uninspected sources and entries are not rejected news. Counts survive pauses and exclude unrelated channel traffic.

The button stays disabled while an operation is queued, running or waiting. Reloading the browser does not cancel it. A busy pipeline retries after two seconds; paused publication retries its saved checkpoint after five seconds. Unit retry deadlines and Telegram account cooldowns remain in force. Transient collection retries reuse the pinned sources and fetch budgets. Terminal connector failures produce partial results, not a broader collection sweep.

Shutdown stops new dispatch at checkpoints. Interrupted running operations wait five minutes on restart. Unknown Telegram outcomes require reconciliation rather than blind resending; a missing send requires operator review. Changing the destination or bot identity ends the run instead of moving its publication IDs.

Ordinary schedules and maintenance continue while the run waits. Processing shares the pipeline lease; publication runs outside it. Usage operation IDs start with `run_now:<operation UUID>:` and retain the original stage or story ID after that prefix.

## API

Submit with the same-origin session and CSRF token:

```http
POST /api/operations
Content-Type: application/json
X-CSRF-Token: <session token>

{"kind":"run_now","options":{"mode":"collect","sourceLimit":1,"inputLimit":2,"storyLimit":1,"publicationLimit":1}}
```

Options are optional. Modes are `collect` and `collected`; limits must be whole JSON numbers from 1 to the maxima above. Unknown fields and missing CSRF are rejected. HTTP 202 returns the operation ID and polling location. `GET /api/operations/:id` exposes saved options and progress in `runNow`. Duplicate starts return the active operation with its original limits.
