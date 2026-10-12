# News delivery reliability and recovery

## What changed

The low-volume audit found failures at collection, generation and delivery. These repairs do not change the saved interest profile, publication threshold, collection schedule or existing source budgets.

| Problem | Repair |
| --- | --- |
| Blocked old articles repeatedly consume the source budget | Persist discoveries, prioritize fresh entries and back off failed reads. Failed attempts count toward the budget. |
| A rotating feed loses already discovered entries | Keep a bounded durable backlog, including partial checkpoints from failed batches. Show overflow and outstanding errors in Sources. Entries never observed between polls still cannot be recovered this way. |
| Undated entries stay excluded after changing policy | Source-editor/API changes recover previously skipped IDs without replaying retained items. |
| HN external links and submission dates differ from publisher feeds | Explicit feed link/date settings and an unsaved HN preset. Existing subscriptions are not silently changed. |
| Completed batches hide collection failures | Keep source counts and safe failure codes. A completed processing batch can still report incomplete source coverage. |
| A summary fails review | Rewrite once, review once more, then publish with a short Russian warning if review still fails. |
| Harmless extraction overlap or malformed review discards a usable partition | Repair only redundant within-event ranges, or independently verify the original valid partition. Never invent boundaries or merge unrelated events. |
| One comparison or link review stops unrelated stories | Retry that selection automatically with backoff. Keep valid stories flowing and reuse successful decisions. |
| Failed items strand successfully extracted siblings | Match and prepare each successful item before dispatching its next sibling. |
| Delivery admission fails without explanation | Store and show historical denial reasons without creating Telegram attempts. |
| Cron overlap protection ends before the work | Return the actual work promise. Keep collection/digest recovery serialized. |
| Historical failures need operator approval | Migration 190 makes parked units retryable without losing collected content or successful results. |

## What publication review now does

Pi writes a Russian headline, summary and source links from the story's mentions and research material in one call. A second call reviews the draft. An unsupported draft gets at most one rewrite and one re-review. The final verdict and a short Russian reason are stored in the generation JSON and publication snapshot.

Review failure does not block sending. Telegram shows `⚠️ Не прошло проверку: <причина>`. If review or correction cannot finish, the last valid draft is saved with a Russian warning. The minimum score, news eligibility and delivery-safety checks still apply. Failures before a valid draft affect only that story, which retries with backoff and is skipped after exhausting attempts. There are no quote or notice fallbacks.

Generation version `generation-v10` replaces the old chain. Hardcoded `Краткий пересказ недоступен` notices and `exact_source_links` receipts are not treated as generated. Normal refresh regenerates them without approval; already-sent posts use the existing edit path.

Luna prompts have no model-input character budget. Mentions, reports and research documents are passed in full. Network fetch byte limits remain. The post prompt asks for at most 1600 summary characters; longer output is trimmed for Telegram, not rejected by generation.

## Status and source settings

Activity shows source coverage, digest recovery, automatic selection retries and recorded publication-admission denials. Denials are history, not proof that a publication is still blocked. Inspect their last observation and current publication/queue state together.

Sources shows backlog usage, failed reads, retry timing and overflow. Supported settings are 1 to 50 article attempts, 1 to 1000 backlog entries and a 1 to 720 minute base retry delay. A retry is admitted only on a later cutoff. Budget and schedule changes need an explicit operator decision.

For an existing Hacker News feed, check external article links and submission-date semantics. Consider a larger attempt budget and undated collect-once only if that coverage is wanted. The HN button opens a new draft; it does not repair or duplicate an existing subscription automatically. A finite backlog cannot recover entries that leave the remote feed between polls.

## Processing retries and rollout

Pi, JEV and embeddings use the same per-item or per-story exponential backoff. `requestMaxAttempts` bounds failures, not successful calls or checkpoints. Exhausted units are skipped. Later batches and healthy siblings continue.

Successful extraction belongs to the immutable item revision. Confirmed-empty output is final even after a checkpoint, restart or profile change.

Back up the database and retain the previous image before deploying. Apply migrations through the normal runner. `190_automatic_processing.sql` removes singleton waiting-batch indexes, reopens legacy parked work, restores quarantined mention associations and retires old operator approvals. It preserves collected data, successful receipts and request audits. No preview/approve/dispatch command or live SQL repair is needed.

See [processing](../src/pipeline/README.md) and [manual runs](run-now.md). Unknown Telegram delivery still uses reconciliation rather than blind resending.
