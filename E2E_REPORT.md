# Implementation and live acceptance

Historical first-trial report. The current full-post revision and its live checks are documented in `PRODUCT_UPDATE.md`.

Validated on 2026-09-30. The application and PostgreSQL containers are running and healthy. This report records the bounded live trial, not a guarantee about future model judgments.

## Running configuration

- Windows settings UI: http://localhost:3030 through the managed WSL loopback forwarder. Direct WSL access: http://127.0.0.1:3000.
- 63 discovered broadcast channels enabled. The destination is excluded from collection.
- Telegram session and Codex OAuth credentials persist in private volumes. Direct container tests passed for JEV, Ollama and `gpt-6-luna`. Codex native JSON Schema output was verified.
- JEV prefix caching and publishing are enabled. Publication minimum is 1; research threshold is 7.
- Collection every three hours, digest at 09:00 and 21:00, cleanup at 04:00, all fixed UTC+02:00. History retention is 14 days.
- Private-source inference remains disabled. The sampled channels are public.

## Quality gates

- TypeScript and ESLint passed.
- Production image built and both Compose health checks passed.
- 453 tests passed against the actual PostgreSQL/pgvector setup, with no skips. This includes isolated migration, restart, reprocessing, embedding-switch, retention and snapshot tests.
- 15 deployment-helper tests passed.
- Real browser settings loaded through the permanent Windows-accessible URL. Publishing, cached prefixes, stored Pi login and all 63 enabled sources were verified. Current processing has no waiting or failed stages.

## Live news trial

Collected 33 public posts from two subscribed channels without marking them read. Replayed their retained revisions after fixing extraction and editorial issues. Final result: 41 mentions, 24 eligible completed stories, and 9 rejected/withdrawn historical story groups. The full subscription list was restored after this trial; processing every channel's initial backlog was not part of the bounded trial.

Read-only editorial review found:

- 23 of 24 final headlines self-contained, 95.8% under the review rubric. One product-update source gives little detail.
- No confirmed unrelated-event merge across nine multi-mention groups. Some preview/release overlap remains an editorial limitation.
- All nine researched summaries checked against retained mentions and fetched evidence. One corrupted personal name was corrected to the primary source's exact spelling.
- Two headline corrections restored the precise numerical scope of a subscription allowance and a model-specific rumored speedup. These three deliberate editorial corrections are recorded in operational state; they were not silently attributed to a fresh model run.
- Course, webinar and conference-registration promotions rejected independently of interest scores.
- Previously missed recap and rumor candidates recovered. Detached availability/quota details remain attached to the correct product.

These are small-sample observations. Grounding in supplied evidence does not prove that every source claim is true. Ambiguous previews, weak source context, transliteration and numerical scope still merit periodic editorial review.

## Publication and recovery

24 news messages and one labeled verification message were published to the supplied destination. Telegram imposed a rate limit after the first 20 news sends. Four durable prepared publications survived the wait and an application restart, then the maintenance loop sent them without selecting new stories or duplicating prior messages. Re-running the digest left the total at 25.

Actual user-account clicks on both a researched publication and an excerpt publication passed after restart. Details, Sources and collapse edited the same message, preserved headline and score, and saved the current view. Buttons are available to every channel viewer. Callback data still has to identify the stored destination/message. Multi-page rendering and history-deletion survival also passed database-backed tests.

A failed Pi SSE request after about 15 minutes exposed insufficient error classification. Known stream failures now produce allowlisted diagnostics and deferred, bounded retries. Opaque failures still require correction rather than blind retry. Completed stages survived the WSL interruption and resumed without recollecting the batch.

## Latency and resource observations

The production database recorded 899 successful JEV requests across initial and corrective trials: median 757 ms, p95 3,880 ms; 577 reported cached tokens. These are not a controlled cache-speed comparison. Prefix mode remains enabled as requested.

The interruption coincided with a WSL restart. Available records did not establish an OOM or disk-full cause. Containers reported `OOMKilled=false`; the host filesystem had 842 GB available. After recovery, WSL used approximately 1.9 GB of its 30 GB allocation with no swap use. Builds, tests and live processing were subsequently run separately.

## Operational notes

See `README.md` for startup, protected credentials, backups, restore, source refresh and reprocessing. On this WSL setup, start Docker Engine and run `bash scripts/start-wsl.sh` after a WSL shutdown. Docker restart policies do not start Docker Engine itself. The managed host relay supplies access to Windows-hosted inference services and the Windows UI forwarder; production still has only two Compose services.

Pi 0.99.1 retains one known high-severity advisory in its bundled `brace-expansion` dependency. This is documented rather than hidden or fixed by silently changing the required Pi version. Browser OAuth onboarding is implemented and tested with simulated callbacks; the live model check used the authorized provider-only credential copy, not a new interactive OAuth login.
