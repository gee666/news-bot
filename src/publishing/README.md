# Publishing

New posts use one of two delivery kinds:
- `text`: one canonical HTML message, rendered from its stored snapshot.
- `media_first`: caption-free media batches, then that canonical text message.

The canonical message contains the score, headline, details, sources and navigation.
It must fit Telegram's 4096-character limit. There are no continuation replies,
separate navigation messages, or caption-first sends.

`ready.ts` selects completed stories. `store.ts` freezes their snapshots.
`freshness.ts` checks dispatch in one SQL query: publishing is enabled, the bot
and destination match, the story is not failed, quarantined or removed, and
its preparation version and generation still match. It does not rebuild content.

`media-plan.ts` freezes up to ten distinct attachments and their upload bytes.
Native photos/videos and documents use compatible batches. Unsupported photo
formats are normalized before upload. Temporary bytes expire after seven days.
A destination reservation prevents another post from splitting media and text.
It ends with a canonical text receipt, terminal failure or unknown text outcome.

Known rejections retry with exponential backoff, at most `requestMaxAttempts` total attempts per send or edit snapshot, default three. Telegram's bot-wide cooldown survives exhaustion. The four-hour publication retry window remains an additional upper bound, not the retry budget.
Unknown outcomes are never resent. Text sends and edits can be reconciled by
reading the channel. Unknown media batches retain diagnostic state without
blocking canonical text; they are not guessed from captions or retried blindly.

A newer confirmed post for the same verified event replaces older posts by
deleting them, not by adding UPD edits. `replacements.ts` stages durable
`publication_replacements` records only after the successor's canonical text
receipt is stored. It requires the same bot and destination. Related events
and unclassified legacy thread links do not authorize deletion. Discovery starts
from changed, confirmed survivors and only considers the old story IDs named in
their pinned generation receipt (or verified directed ancestry for legacy receipts).
The history lock is not used to rediscover candidates on idle ticks.

New snapshots retain inherited factual sources, but contain no `earlier`
summary or previous-publication links. Frozen legacy snapshots remain readable
for reconciliation. `thread-updates.ts` stages replacements before related-link
repairs and retires old previous-post links as hidden audit. Related-link and
source repairs still use `editMessageText`, or `editMessageCaption` for legacy
albums with a 1024-character limit. An edit that cannot fit is skipped and
records `publication_navigation_requires_new_edition`.

`digest.ts` and `run-now.ts` resume durable work under the digest lease.
`maintenance.ts` runs recovery without selecting new stories.
`verifyBot` sends and edits one registered technical test while publishing is enabled.
`repair.ts` resumes replacement deletions and refreshes pending proofs against
the latest confirmed survivor without resetting attempt counts or cooldowns.
Each delete rechecks the stored proof, current publishing admission and verified
same-event identity. Unknown edits block deletion until reconciled. Known media
siblings are deleted before canonical text, retaining per-item progress. Unknown
old media receipts require review. Unknown deletes, including interrupted running
attempts after restart, are terminal and never blindly resent. Manual runs only
delete predecessors of their selected posts. There is no operator repair or
approval entry point.

### Maintenance rollout checks

Migration `212_publication_thread_events.sql` seeds one bounded-drain backlog for
existing navigation repairs and already-covered successors. Delivery, snapshot,
visibility, and relevant relation changes write subsequent work in the transaction
that recorded the change. Monitor the backlog after migration and after a restart:

```sql
SELECT kind, destination_id, blocked_by IS NOT NULL AS deferred,
       count(*), now() - min(queued_at) AS oldest
FROM publication_thread_events
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

Unblocked rows for the active destination and global graph rows should drain as
maintenance runs. Rows for inactive destinations or with unresolved media/edit
receipts can remain. Also watch `publication_replacements` counts by status and
`error_code`, and compare `news-bot-history` lock waits and maintenance tick time
before and after rollout. If backlog age grows, inspect the first failed maintenance
tick and settings before intervening; do not clear queued events or replay unknown
Telegram operations.

Permanent edit admission denials retire the pending snapshot. Per-snapshot settlement records prevent staging unchanged navigation or source repairs again. Unknown edits get at most `requestMaxAttempts` read-only reconciliation attempts, with backoff. Exhaustion preserves a terminal ambiguity marker, so recovery cannot blindly resend the same attempted snapshot. Different desired content can get its own edit budget. Ambiguous duplicate edit attempts stop immediately for review.

Maintenance backs off consecutive infrastructure failures and stops that worker after the configured attempts. An explicit service restart starts a new worker burst; scheduled and manual digest runs remain independent. Publication attempts and settlement records do not reset on restart. Pipeline recovery does not reopen exhausted operational work; an explicit manual operation or a new scheduled digest can start a new operational burst.
