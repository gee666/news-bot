# Media delivery

New posts with media send caption-free attachments first, then one complete HTML
text message. Text-only posts send just that message. Media IDs are not canonical
post IDs, and attachments are never replies or navigation targets.

The publisher freezes up to ten distinct images/videos before dispatch. Images
that Telegram cannot send as photos are normalized. Native photos/videos share
batches; documents use separate batches. Every batch must finish before text.
Temporary upload bytes expire after seven days, including unresolved requests.

A persisted destination reservation keeps another post from interrupting delivery.
It is released only when the canonical text receipt commits. Explicit rejections
can retry the same bytes. Unknown outcomes are never resent; an unknown media
batch keeps the destination blocked rather than guessing which uploads succeeded.

Existing album posts can receive caption edits, but new posts never use captions.
An edit exceeding 1024 characters is skipped with
`publication_navigation_requires_new_edition`. Text edits have a 4096-character limit.
