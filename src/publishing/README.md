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
Only a committed canonical text receipt releases the reservation.

Known rejections retry with backoff and Telegram's bot-wide cooldown.
Unknown outcomes are never resent. Text sends and edits can be reconciled by
reading the channel. Unknown media batches retain their receipts and block
further delivery; they are not guessed from captions or retried blindly.

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
