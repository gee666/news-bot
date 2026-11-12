# Media delivery

New posts with media send caption-free attachments first, then one complete HTML
text message. Text-only posts send just that message. Media IDs are not canonical
post IDs, and attachments are never replies or navigation targets.

The publisher freezes up to ten distinct images/videos before dispatch. Images
that Telegram cannot send as photos are normalized. Native photos/videos share
batches; documents use separate batches. Batches are limited to ten files and
45 MB of combined file bytes, leaving room for multipart overhead below Telegram's
request limit. A larger inherited media selection is split into multiple uploads
without dropping files from the frozen selection. Each batch must have a receipt or a
terminal outcome before text. Temporary upload bytes expire after seven days,
including unresolved requests.

A persisted destination reservation keeps another post from interrupting active
delivery. Retryable upload failures reuse the frozen bytes within the configured
attempt budget. Failed, expired and exhausted attachments are skipped. Unknown
uploads are never resent and keep their diagnostic state, but do not block the
canonical text. The reservation ends when text succeeds, permanently fails, or
has an unknown outcome. Unknown text is reconciled through reads, never blindly
resent. Startup also clears reservations left by terminal publications.

After deduplication, pictures from a source revision with exactly one extracted
event belonging to the story or a verified ancestor bypass relevance screening.
Multi-event source pictures and research media still receive relevance screening.

Unavailable source attachments are omitted without failing text generation.
`MEDIA_PREPARATION_TIMEOUT_MS` sets the total optional media deadline in milliseconds,
defaulting to `120000`. Source lookup, cache reads, downloads, decoding,
deduplication, JEV comparison and relevance screening share this budget. Summary
image encoding uses the same total budget from the start of summary preparation,
not a fresh timeout per image. A timeout or unexpected preparation failure returns
no attachments so topic text generation and publication can continue. Individual
missing downloads or undecodable images can still leave healthy siblings intact.

Cancellation stops codec processes and model requests, including requests queued
behind another inference call. Sequential loops check cancellation before starting
more work. Expired work cannot start a later selection-cache write or retain a late
pair verdict. Release cancels preparation instead of waiting for it, serializes
cache removal after an in-flight save, and bounds the caller's cleanup wait by the
same setting. A still-pending removal blocks new preparation for that story until
it finishes, so it cannot delete a newer selection. Cleanup failures are left for
the startup/hourly sweep.

Privacy checks still apply before downloads and inference. Denied private media
is omitted, never sent to a model or restored from the selection cache.

Existing album posts can receive caption edits, but new posts never use captions.
An edit exceeding 1024 characters is skipped with
`publication_navigation_requires_new_edition`. Text edits have a 4096-character limit.

History cleanup removes cached pictures and videos belonging to deleted stories
after the database transaction commits. Startup and hourly sweeps retry orphaned
file cleanup, without waiting for the seven-day cache deadline. Published Telegram
posts and their publication history are not deleted.
