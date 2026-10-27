# Immediate publishing

A completed story enters the durable ready queue. The publisher selects it once,
freezes a snapshot, and sends one canonical HTML message. If the story has media,
caption-free batches go first. There are no continuation or navigation replies.

At each request boundary one SQL query checks publishing enablement, bot and
destination identity, story failure/quarantine/removal, and the story version and
generation recorded when the snapshot was prepared. Dispatch does not regenerate
or rebuild the snapshot. Changed inputs require a newly prepared edition.

The digest lease serializes delivery. Media-first work also reserves its destination
until the canonical text receipt commits or that send reaches a terminal failure
or unknown outcome. Failed or unknown attachments do not block canonical text.
Maintenance resumes prepared work and reconciles unknown text sends and edits
without selecting more stories. Unknown media batches and unknown text sends
are never blindly resent. New canonical posts precede edits and replacement
maintenance. Automatic edit recovery handles one post per pass, prioritizing pending snapshots
without running or unknown edit attempts before reconciliation. Each group is
oldest first. Unresolved reads back off exponentially from the existing retry
base, doubling per reconciliation pass up to six hours on the original attempt.
Unknown edits are never resent. Telegram cooldowns
apply across publications.

Run-now freezes its own publication selection and reports delivery outcomes for
that selection. It does not republish an existing post.

When a newer edition is published, old posts may receive an UPD link and related
links inside the canonical message. Existing text posts use text edits; old album
posts use caption edits. Oversized edits are skipped and record
`publication_navigation_requires_new_edition`. Operator repair and approval APIs
are not part of publishing.
