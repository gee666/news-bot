# Cumulative publication media

`publicationMedia(storyId, settings)` returns every retained, distinct attachment from the draft and all its ancestors. It uses `generationThread` from `pipeline/generation-context.ts`, including durable publication lineage. Ancestor mention and supplementary-source revisions may be historical. Draft revisions must still be current.

Source media stays subject to the seven-day collection window and pipeline-failure checks. Supplementary sources must remain relevant and evidence-eligible. Research attachments must be public, relevant, unsuperseded, unexpired, and fetched within seven days. Inference approval runs before any selection-cache lookup or download, including when ancestor source access changes.

There is no attachment-count cap here. The 256 MB aggregate download budget fails the operation rather than publishing an incomplete selection. Telegram batching belongs to publishing. The summary-image cap applies only to `summaryImages`, never publication media.

## Duplicate decisions

Exact bytes bypass codecs and models. Image candidates with identical normalized PNGs also receive a full-resolution RGBA hash check, including dimensions, without resizing. Animated inputs and video frames cannot use that shortcut. Equal grayscale thumbnails alone never prove identity. Duration gaps and clearly different thumbnails avoid model work. Remaining pairs go through vision evidence extraction and JEV judgment.

`MediaPairCache` stores explicit `same` and `different` model verdicts under `tmp/media-pair-cache/`. Keys are symmetric and include raw attachment identity plus vision provider/model, JEV endpoint/model, model revision, evidence/prompt versions, and preparation policy. Cache hits happen before decoding. Unresolved decisions, errors, and legacy boolean results are not persisted as pair verdicts. Concurrent reversed comparisons share one in-process request.

Files contain only hashed identities, a verdict, and expiry. Writes use private files and atomic rename. Entries expire after seven days without refreshing on reads, and `cleanupMedia` sweeps them. Publishing releases story media files but keeps reusable pair verdicts. Compose mounts the `media_pair_cache` volume at `tmp/media-pair-cache`, retaining these hash-only decisions across container replacements. Without that mount, a local cache survives process restarts but not replacement of temporary storage.

Final selection fingerprints include the model/prompt policy. Unresolved comparisons retain attachments under a provisional fingerprint that cannot satisfy a final-selection lookup. The next call retries those comparisons while preserving the original first-download deadline. Decoder/download errors fail the operation rather than silently discarding media.
