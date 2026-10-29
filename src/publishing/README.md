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

Existing posts are edited, never republished. `thread-updates.ts` stages UPD
markers and related links inside the canonical post. Text posts use
`editMessageText`; existing album posts use `editMessageCaption`, limited to
1024 characters. Navigation-v2 re-stamping remains for unstamped stored posts.
An edit that cannot fit is skipped and records
`publication_navigation_requires_new_edition`.

`digest.ts` and `run-now.ts` resume durable work under the digest lease.
`maintenance.ts` runs recovery without selecting new stories.
`verifyBot` sends and edits one registered technical test while publishing is enabled.
The production replacement retry in `repair.ts` only finishes already-recorded
replacement deletions. There is no operator repair or approval entry point.

Permanent edit admission denials retire the pending snapshot. Per-snapshot settlement records prevent staging unchanged navigation or source repairs again. Unknown edits get at most `requestMaxAttempts` read-only reconciliation attempts, with backoff. Exhaustion preserves a terminal ambiguity marker, so recovery cannot blindly resend the same attempted snapshot. Different desired content can get its own edit budget. Ambiguous duplicate edit attempts stop immediately for review.

Maintenance backs off consecutive infrastructure failures and stops that worker after the configured attempts. An explicit service restart starts a new worker burst; scheduled and manual digest runs remain independent. Publication attempts and settlement records do not reset on restart. Pipeline recovery does not reopen exhausted operational work; an explicit manual operation or a new scheduled digest can start a new operational burst.
