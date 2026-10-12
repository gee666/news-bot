# Full-post revision

Completed 2026-09-30. This supersedes the presentation and editorial behavior described in the original `E2E_REPORT.md`. The broader developing-story/DevDay architecture is deferred.

## Channel changes

- Updated all 21 retained news posts in place with short Russian headlines, readable details, interest score and source links. No buttons or collapsed views.
- Consolidated three redundant posts into their concrete-event counterparts. Edited the canonical messages before deleting tracked duplicate messages 6, 22 and 27. The registered verification post was also converted to full text; unrelated messages were untouched.
- Grouped assessed primary sources first, other useful external links next, and contributing Telegram posts last. Advertising links are excluded. Every retained URL survives rendering; long labels compact without dropping destinations.
- Source-only recap posts can contribute links without becoming separate news stories. The previously unassigned official DevDay recap is now associated with related concrete stories. This does not introduce a broad DevDay story or merge unrelated announcements.

## Implementation

Same-event matching now compares the current report sets and reconciles existing groups. Durable aliases retain publication identities and source provenance. Preview/announcement differences do not automatically create separate posts, while independent products remain separate.

All stories get concise details. Low-interest stories use supplied links only; extra web search is disabled in the current saved settings. Source-link classification and optional assessment do not treat an inaccessible page as advertising. New source-only associations require text-grounded confirmation, not just overlapping words such as Cloud or API.

Generated text receives a separate grounding check and one editorial revision if needed. Reports carry publication timestamps so an earlier rumor does not invalidate a later announcement of the same event. This is not a guarantee of perfect model judgments: final review corrected an unsupported Decisions API issuer and a stale relative date in the Pro copy. Those manual reviews are recorded separately in operational state.

Publication snapshots update only after successful Telegram edits. Uncertain sends are reconciled rather than blindly repeated. Duplicate deletion requires a successfully updated canonical post. Repeated repairs do not re-edit unchanged posts, and merged source labels remain stable rather than accumulating on every edit.

An invalid extraction after its permitted repair now withholds that item instead of blocking every independent item. Authentication, provider availability and rate-limit failures still pause work. The UI reports completed batches with withheld items explicitly.

## Verification

- Typecheck and lint passed.
- 586 tests passed against the real PostgreSQL/pgvector test setup, with no skips in that run.
- Read-only preflight found all 21 news posts eligible and renderable, with zero missing source URLs.
- Live Telegram read-back checked all 21 news posts and the verification message. Their text and URL entities/offsets matched the saved render exactly. All 22 messages had no buttons or reply markup.
- The news posts contained 1–11 links each, with 112 link entities across the checked messages. Full text ranged from 320 to 1246 UTF-16 units, below Telegram's 4096 limit.
- Deleted duplicate IDs returned `MessageEmpty`. No read acknowledgements or view increments were sent during the audit.

## Current operation

The application and database are running. Publishing and JEV prefix caching are enabled; all 63 subscriptions remain enabled. Settings UI: http://localhost:3030 on Windows, or http://127.0.0.1:3000 inside WSL.

The external JEV service at host port 8765 became unavailable during the correction pass and remains unavailable at final check. The 430-item collected backlog is saved; available cached work can continue, but uncached JEV work must wait for that service. No new Telegram login is needed. Restart the external JEV service and check the processing status; a terminal exhausted retry may need the UI's collection/resume action. The news application does not own or restart the external inference server.

Final resource check showed about 2.4 GB WSL memory use, no swap use and 842 GB free disk space. No evidence of OOM or disk exhaustion was found.
