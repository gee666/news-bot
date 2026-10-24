# Images and videos

Collectors save media locations in revision metadata, not media bytes. Web articles, feed enclosures and Telegram albums supply images and native video attachments. Embedded players that expose only a player page, such as a YouTube iframe, are not downloadable video attachments.

Each event edition gathers media from its current and ancestor reports, relevant supplementary sources and relevant research pages. Only verified SAME-event ancestry contributes media, not RELATED events or unverified legacy edges. Historical ancestor revisions remain usable while their metadata is retained. Source validity and privacy approval still apply; there is no separate seven-day source-age cutoff. Distinct attachments are retained across all sources, not just the latest report.

## Duplicate detection and model calls

Repeated locations download once per selection. Exact size and SHA-256 matches need no decoding or model call. Still images can also bypass the model when their full-resolution RGBA pixels and dimensions are identical. Animated images and extracted video frames cannot use that shortcut. Equal grayscale thumbnails alone never prove identity.

Videos with similar duration are compared using frames one third into each video. Different durations skip visual comparison. Grayscale thumbnail differences reject obvious nonmatches. Ambiguous comparisons send two compressed WebP images to the vision model for structured visual evidence. The text-only JEV endpoint makes the final identity decision from that evidence. Failed or unreadable comparisons retain both copies and can be retried later.

Symmetric pair-cache keys include attachment identity and the model, prompt and preparation versions. Explicit same and different verdicts are reused across editions before decoding. Concurrent comparisons share the same request. Unresolved judgments and outages are never cached as reliable verdicts. Compose persists only hashes and decisions in the `media_pair_cache` volume. Cache entries expire after seven days without refreshing on reads.

Summarization and review receive text plus deduplicated still images. Model-only WebP copies use quality 90 and fit inside 2560×2560 without upscaling. Telegram receives original bytes without bot-side recompression. Videos and video frames never enter editorial summarization. `MEDIA_SUMMARY_MAX_IMAGES` defaults to 10 and accepts 1 through 10. It limits model input, not published attachments. `MEDIA_VIDEO_DURATION_TOLERANCE` defaults to 0.2, a fraction of the longer duration. The minimum video-duration tolerance is two seconds.

## Telegram delivery

New editions use a canonical HTML text post containing the cumulative event summary, all source links and links to all previous editions. They do not squeeze the news into a 1024-character caption or omit links to make room for media. Text exceeding Telegram's 4096-character or 100-entity limits uses ordered continuation replies. All text parts are frozen in PostgreSQL before sending.

Every distinct retained attachment is sent as a reply to the canonical post. Compatible photo/video or document batches contain at most ten items each. More than ten attachments create additional batches. Incompatible formats are sent in their own document batches rather than discarded. Single attachments use their native send method. Each batch has durable upload state, hashes and tracked Telegram IDs.

After all text and media are confirmed, every earlier edition receives `UPD: <latest post URL>` above its title. News text and sources on those older posts remain unchanged. Existing caption-bearing albums keep their original delivery/reconciliation lifecycle; they are not blindly resent or converted. No automatic deletion is part of the edition policy.

Explicit temporary Telegram rejections can retry their frozen plans. Unknown text or upload outcomes require reconciliation or review instead of blind resend. An incomplete publication does not count as fully successful in run-now results. Authorized deletion includes tracked continuation and attachment messages.

## Temporary storage and limits

Downloaded media is temporary. `tmp/media-cache/` contains per-story bytes, removed after confirmed attachment delivery. Files expire after seven days, checked at startup and hourly. Video decoding uses memory where possible and deletes seekable fallback files immediately; abandoned decoder files expire after 24 hours. Keep `tmp/` private. Media byte caches are not mounted as permanent Docker volumes. The separate persisted pair cache contains no media or source URLs. The seven-day deadline limits cached bytes, not the lifetime of retained source metadata. A later edition can download an older attachment again while its source descriptor remains in PostgreSQL. Metadata lifetime follows configured source/evidence retention and its cleanup rules, not the media cache clock. Expired retained ancestor research can still contribute attachments, just as it contributes historical text; current-draft research must remain unexpired. Superseded or irrelevant research is excluded in either case. Deleted descriptors cannot be reconstructed from text-only publication snapshots; inaccessible downloads fail preparation rather than silently omitting media.

PostgreSQL temporarily spools upload bytes before dispatch for restart safety. Confirmed uploads erase those bytes immediately. Maintenance also erases unpublished or unresolved bytes after seven days. Telegram message IDs and hashes remain for audit and authorized deletion. Backups and WAL can retain prior temporary data according to the operator's database-retention policy.

The runtime requires `ffmpeg` and `ffprobe`; Docker installs both. Web media fetches use public-address validation, DNS pinning, redirect checks and streaming byte limits. Limits are 9 MB per image, 45 MB per video and 256 MB total per event selection. There is no attachment-count cap. Unsupported or unavailable downloads and exceeded byte budgets stop preparation explicitly rather than silently dropping requested media.
