# Media delivery

New posts with media send caption-free attachments first, then one complete HTML
text message. Text-only posts send just that message. Media IDs are not canonical
post IDs, and attachments are never replies or navigation targets.

The publisher freezes up to ten distinct images/videos before dispatch. Images
that Telegram cannot send as photos are normalized. Native photos/videos share
batches; documents use separate batches. Each batch must have a receipt or a
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
Privacy checks still apply before downloads and inference.

Existing album posts can receive caption edits, but new posts never use captions.
An edit exceeding 1024 characters is skipped with
`publication_navigation_requires_new_edition`. Text edits have a 4096-character limit.
