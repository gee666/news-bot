# Channel publications

Each event has one HTML message with a ten-dot interest bar above the Russian headline, summary and source links. The reviewer returns only actual issues in a remarks array, or an empty array when there are none. Only non-empty remarks appear as `Заметки проверяющего: <причина>`. Existing sent snapshots are not refreshed merely to change review wording. Review is informational, not an admission gate. The verdict and reason come from the generation JSON and are retained in the publication snapshot. New sends still require the minimum score and current generation.

Follow-ups show the full topic headline, `Новое`, `Ранее было опубликовано`, `Первоисточники`, `Вторичные источники` and `Предыдущие публикации`. Sources combine the whole thread; previous-post links are oldest first. Repetitions add sources to the latest sent post instead of sending again. Snapshots hold at most 90 sources, dropping inherited secondary links first.

Source links come from current collected mentions, source-only reports and successfully read, relevant research documents. All eligible current mention origins remain in the source list; the writer's partial URL selection cannot hide them. A single origin classification distinguishes primary publications from relays. Collected links classified as origins stay in the primary source list even when a crawler cannot read them; that is provenance, not independent verification. There is no claim-level citation or source-authority contract. Public feed/website reads still require collector metadata. Expired, superseded, irrelevant, inaccessible or failed fetched pages are not published as sources. Primary research sources appear first. Titles come from read content, not advertising anchors.

The renderer respects Telegram's 4096 visible UTF-16 and 100-entity limits. It compacts source labels, then trims earlier history before new details without dropping links or reviewer notes. Stored snapshots retain full text and labels. There are no buttons or pages; edits clear old inline keyboards.

Send attempts persist a content/link fingerprint before dispatch. Unknown Telegram sends are never blindly resent. Reconciliation requires a unique destination, content and attempt-time match. Missing fingerprints or ambiguous matches need manual delivery review. This is separate from the summary's Pi review.

Duplicate reports stage a source-only snapshot using the sent headline, details, earlier summary, score and review unchanged. Source-only edits do not require regenerating the published text. A successful edit switches the published snapshot pointer; unknown edits retain the old pointer for reconciliation. Current input, settings, destination, bot ownership and saved cooldowns are checked before delivery. Admission denials are diagnostic records, not Telegram attempts. Explicit repairs use their existing approval path.

`publishDigest` captures eligible ready events in one query. The default `digestCron` is `0 */3 * * *`. Events arriving during selection wait for the next digest. Manual-origin ownership still prevents an automatic path around a manual run's cap.

`startPublicationMaintenance` resumes previously prepared sends, reconciliation, edits and replacement deletions every five seconds by default. It does not select new ready events. `PUBLICATION_READY_INTERVAL_MS` accepts 1000 to 60000 milliseconds. See [timing and ownership](../../docs/immediate-publishing.md).

`previewPublicationRepair` inspects tracked posts without writes. `repairExistingPublications` edits tracked canonical posts before deleting authorized duplicates. Unknown or untracked messages are not deletion targets. `{ includeVerificationTest: true }` includes only the registered technical test. No Telegram callback polling runs.
