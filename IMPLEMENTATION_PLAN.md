# High-level implementation plan

## Product changes requested after the live trial

These changes supersede the original presentation and low-interest processing requirements below:

- Publish one full message per event, with a short natural Russian headline, concise details and all retained source links. No buttons or collapsed views.
- Merge previews, announcements and additional coverage of the same event. Update its existing publication instead of sending another post. Preserve all contributing Telegram origins and useful supplied links.
- Classify supplied links per story, exclude advertising/navigation, and display useful external links before Telegram coverage. Source-only recap posts may contribute links without becoming new stories. Do not label an unverified link as an assessed primary source.
- Extra primary-source research is optional, not a prerequisite for displaying supplied links. Lower-interest stories use supplied links only; higher-interest stories may receive bounded additional research.
- Keep durable complete snapshots, safe retries and history-independent delivery. Reviewed corrections must successfully update the canonical post before removing tracked duplicate posts.

The sections below record the original implementation plan and remain applicable where not superseded above.

## Scope

Build a personal news aggregator with Telegram as the first input and output. Design for email subscriptions, website scraping, and feeds from the start, but implement only the Telegram connector in V1. V1 processes text and captions only. No tags, image analysis, video processing, or audio transcription.

Use node-cron to collect and process news in scheduled batches, initially every three hours, with configurable cron expression and timezone. Do not continuously poll or subscribe to Telegram news updates. Each run collects eligible new items, then processes that collected batch through the pipeline. Keep digest publication on a separate configurable schedule, initially twice daily, using completed stories only. Keep low-interest stories available without researching or summarizing them. Publish all interest levels by default, with a configurable minimum publication score. This does not include rejected non-news or irrelevant advertisements. Publish headlines, generated details, source-section labels, and buttons in Russian.

## Architecture

This is a single-user application. Build the working news pipeline, not a reusable platform.

- Use TypeScript throughout: one Node.js backend with a scheduled processing loop, Telegram bot handlers, and a small settings API, plus a React frontend. Serve the built UI from the same application container; no separate frontend service in production. Save processing status in the database so interrupted batches can resume. No job-queue framework or separate workers.
- Two Compose services: the application and PostgreSQL with pgvector. Start with exact vector search over recent stories; do not build approximate indexes or dimension-reduction machinery unless measurements show a need.
- Treat JEV and embeddings as independent external HTTP services. Do not implement model loading, unloading, GPU locks, leases, or coordination in V1. For generative requests, install a pinned Pi version in the application image and call its SDK directly from the Node.js backend.
- Use ordinary modules and database queries, not a generic database abstraction or plugin framework. Keep source items independent of Telegram so an email or website collector can use the same pipeline later.

## Deployment

Provide a Dockerfile, compose.yaml, and .env.example. Use the terminal for setup and operation: after configuration and initial Telegram login, run `docker compose up -d`. Docker Engine with the Compose plugin is the primary Linux deployment target; no Docker Desktop GUI is required. Windows can use Docker Engine inside WSL2; macOS needs a Linux VM runtime such as Colima. Keep application code OS-independent.

Persist database data and Telegram sessions in volumes. Keep credentials out of source control. Publish PostgreSQL on host loopback for debugging, using `127.0.0.1:${DB_PORT:-5432}:5432`, with password authentication. Connect from another machine through an SSH tunnel rather than exposing the database publicly. The application connects internally to `db:5432` regardless of the host port. Include a database health check, restart policy, simple schema migrations, logs, and short setup and backup instructions. No deployment platform or monitoring stack.

## Web UI and settings

Build a small React settings page, not a full administration platform. The first setting is a plain-English personal interest profile in an editable text area. Seed it with: "I want actual AI and technology news, especially LLMs, programming, computer hardware, and developments in the technology industry. Prioritize concrete announcements, releases, findings, and industry events. Exclude educational content, courses, prompt collections, tutorials, and advertisements. I want news, not promotional or instructional material." Also expose endpoint URLs and model names for JEV and embeddings, Pi provider/model selection and login status, plus the research threshold, minimum publication score from 1 to 10, collection cron schedule and timezone, digest schedule, retention period, and publishing toggle. Default the minimum publication score to 1, meaning all interest levels, and keep it separate from the research threshold of 7. Default the timezone to fixed UTC+02:00 without daylight-saving changes; use an explicit compatible timezone identifier such as `Etc/GMT-2` and display it as UTC+02:00. Provide Save and Test connection actions. Store settings in PostgreSQL; keep secrets server-side and never return saved secret values to the browser.

Bind the web port to host loopback by default and use an SSH tunnel for access from another machine. Do not expose the unauthenticated settings UI publicly.

Apply saved settings between processing batches. Track the profile and model versions used for judgments. Changing the profile marks existing interest scores stale; refresh active stories before selecting the next digest. Changing the embedding model, dimensions, or input preparation requires re-embedding the active search corpus before switching retrieval; never compare vectors from different embedding configurations, even if their dimensions match.

## Generative LLM through Pi

Use Pi for extraction fallback, source assessment, and headline/summary generation. Use OpenAI Codex OAuth with model ID `gpt-6-luna`, which the user confirms is accessible through this Pi account. During implementation, test it through the application's Pi integration; report any integration failure rather than silently substituting another model. The React UI starts Pi's login flow, shows the provider authorization link, and accepts a pasted redirect URL when a browser callback cannot reach the container. Use Pi's auth implementation for PKCE, state checks, token exchange, and refresh. Persist its credentials in a protected volume; never send tokens to the browser or log callback URLs. Login itself happens on the provider's page, not a proxied password form.

For initial Docker testing, the user authorizes copying this Pi installation's OpenAI Codex OAuth credential into the application's private Pi auth volume. Copy only the Codex provider credential, not the whole Pi directory or unrelated provider credentials. Perform the copy without printing secrets; never include credentials in image layers, build context, source control, or test artifacts. Do not share a writable auth file with the running development Pi. Refresh-token rotation may affect the original session; do not assume copied credentials remain independent. Later replace the test credential by logging in through the app's web UI.

Make each inference request independent, with a task-specific system prompt, no tools, skills, extensions, prompt templates, project instructions, or previous conversation. Use explicit SDK resource configuration rather than relying on an empty working directory. The Node.js backend performs searches and page fetching and supplies evidence to Pi; Pi cannot browse on its own.

Use ordinary text output where sufficient, especially for summaries. During implementation, test native structured output with the actual Codex model and authentication; use it where machine-readable output is needed if enforcement works. The inspected Pi 0.99.1 Codex adapter has no first-class response-schema option; its lower-level payload hook can potentially supply Responses API text.format JSON Schema. Pi JSON event mode is not schema-constrained model output. If native constraints are unavailable, prompt for JSON only for tasks that need it, such as extracted spans and batched headline-to-story mappings. Validate the result, allow one repair attempt, and leave the stage failed if still invalid. Do not substitute tool calls for structured output because tools are explicitly disabled.

Do not impose application-level spending or daily model-request quotas. When the provider reports a recoverable rate or usage limit, save progress and retry after its Retry-After or reset time; otherwise use increasing delays. Keep the UI responsive, show the waiting reason and next retry time, and preserve the wait across restarts. Authentication failures, unavailable models, and invalid requests need correction, not endless retries. Request deadlines and context-size handling still apply.

## Telegram onboarding and live testing

Make terminal-based Telegram login the first working feature. The user supplies the account login code and any two-step-verification password interactively; never put them in prompts or logs. Persist the session in a protected volume.

After login, list subscribed broadcast channels through the API, save their stable IDs and names as enabled sources, and show the discovered list. Provide a simple refresh command to discover new subscriptions and mark departed channels inactive without deleting collected data. Preserve manually disabled sources during refresh.

Immediately add a read-only live smoke test: fetch a small recent sample from the discovered channels without marking messages read, joining channels, or publishing anything. Use these samples to test extraction, link association, and later matching and ranking as each stage is built. The development assistant can inspect necessary samples through the app's commands; it must not inspect session secrets. Keep raw test samples out of source control and do not send private content to external inference providers without approval.

Use the same private Telegram channel for live publication tests and production: `https://t.me/+5cDKe78ahR02Y2Ey`. No separate test channel is needed. Resolve and persist its numeric channel ID after the user-account login; the Bot API cannot publish to an invite URL. Verify that the supplied administrator bot can post and edit its own messages. Read its token from a server-side secret such as TELEGRAM_BOT_TOKEN; do not put the token in this plan, source control, or logs. Exclude this destination from input discovery. Keep scheduled publishing disabled until the live send/edit test passes; perform only the small number of clearly labeled test posts needed.

## Processing flow

1. **Collect.** Use the dedicated Telegram account's subscribed broadcast channels as the source list. Discover them through the Telegram API and save them as enabled sources; no manually written allowlist or model-based discovery is needed. Exclude private chats, groups, and the output channel. Initially import at most the past 48 hours and track collection cursors independently of Telegram read status. Save original text, message identity, and timestamps. Extract and save all explicit URLs once per item revision, including hidden Telegram text links, with anchor text and positions. Skip media-only messages without usable text.
2. **Extract stories.** Ask JEV for `none`, `1–20`, or `more`. Try deterministic text splitting and validate the proposed split. Use a cheap generative LLM when splitting fails or is uncertain. A predicted count is a hint, not a required extraction result.
3. **Classify and associate links.** Reuse the links extracted during collection; do not extract them again. Use text positions to propose story associations, then ask JEV about ambiguous associations and link relevance using the story, anchor text, and surrounding message text. Classify each link as relevant, irrelevant advertising/navigation, or uncertain. A link may support several mentions. Preserve all extracted links and decisions internally; hide clearly irrelevant links from story sources. Keep uncertain links as unverified candidates. A self-link or promotional product page may be relevant evidence, so domain or promotional wording alone is not a rejection rule. This stage does not fetch destinations or verify primary sources; interesting stories get that work during research.
4. **Find matches.** Embed individual story mentions. Retrieve a bounded number of candidates from recent stories without tags. Keep the matching history longer than the collection window; use shared source URLs as additional candidate evidence.
5. **Judge duplicates.** Have JEV distinguish the same event, meaningful updates or corrections, and different events. Allow no match. Attach each mention to an existing story or create a new story.
6. **Rank interest.** Have JEV score each story from 1 to 10 against an explicit personal interest profile. Keep interest separate from evidence quality and model confidence. Reassess when meaningful information arrives.
7. **Choose processing depth.** For low-interest stories, have JEV choose the best original excerpt. Retain other mentions and relevant links without summarization. For interesting stories, fetch likely primary sources, perform bounded search if needed, and summarize the supporting mentions and primary evidence. Start with a configurable research threshold of 7/10.
8. **Prepare headlines.** For researched stories, have Pi return a one-sentence factual headline and detailed summary in the same request. For low-interest stories, send their chosen excerpts to `gpt-6-luna` in small batches, initially up to 10 stories per request, and request one headline per stable story ID. Validate that every input ID appears exactly once with no extra IDs or facts mixed between stories; split batches if input/output context limits require it. Do not research or summarize these low-interest stories; their Details view uses the chosen source excerpt, labeled as such.

Headlines should be short, natural, and self-contained: identify what happened and include the distinguishing result, consequence, or key number when supported. Avoid clickbait, vague teasers, and unnecessary jargon. Preserve uncertainty and attribution for rumors and allegations rather than making them sound confirmed. The product goal is that roughly 85% of posts can be understood without opening Details; treat this as an editorial target to evaluate on real stories, not a guaranteed metric. Save headlines and regenerate only when meaningful evidence changes the story.
9. **Publish.** Send one channel message per selected story, initially showing only its headline with Details and Sources buttons. Button callbacks edit that same message in place, never open private bot chat or create a new message. Support three exclusive views: collapsed, details, and sources. Every view preserves the same headline. Details shows the stored summary with Russian Hide details and Show sources buttons. Sources shows relevant source links with Hide sources and Show details buttons. Hiding returns to the headline-only view; switching replaces the previous expanded section. Edits are shared by everyone viewing the channel, not private to the person clicking.

The sources view lists assessed primary sources first, followed by all retained mention origins and other relevant supporting links. Include a link to every original Telegram post where the story was collected, using compact labels such as channel name plus message number. Use direct public-message URLs when available; private-message links remain access-restricted and must not be presented as public. Deduplicate identical destinations without dropping distinct mention origins. Use clickable labels rather than a URL-shortening service. Keep link classification and access limitations visible where needed.

Store the Telegram publication ID and current view so callbacks work after restarts. Render all views from stored data without model calls. Escape Telegram formatting and serialize edits per message to handle repeated or competing clicks. Expanded text must fit Telegram's message limits; paginate long details or source lists within the same edited message, preserving the headline and navigation. Display the personal interest score in every view beneath the headline, for example `Интерес: 8/10 · ▰▰▰▰▰▰▰▰▱▱`. Render buttons and section labels in Russian: `Подробнее`, `Источники`, `Скрыть подробности`, and `Скрыть источники`. Generate headlines and summaries in Russian regardless of source language, preserving names, numbers, and attribution. For low-interest source excerpts in another language, request a faithful Russian translation alongside their batched headlines rather than a researched summary; store it for the Details view.

## Scheduled batches

Use node-cron with `0 */3 * * *` as the initial collection schedule, interpreted in the configured timezone. At the start of a run, record a cutoff and collect unseen items up to it, subject to the 48-hour collection limit. Persist the collected batch before processing; items arriving after the cutoff wait for the next run. Advance each source cursor only after its items are saved.

Run only one collection/processing batch at a time. If the next cron tick arrives while a batch is active, skip that tick rather than overlap or accumulate queued runs. Resume unfinished work after restart before accepting a new batch. Persist batch membership and progress using ordinary database records, not a queue framework. New schedule settings apply to future runs, not the active batch.

Within a batch, process ready items in stage/template groups to reuse JEV prefixes. Keep the settings UI and Telegram button handlers responsive while processing; they are not restricted to cron runs. Scheduled digest publication reads completed, unpublished stories without waiting for an unfinished batch or publishing partial results.

## Model requests

Call JEV and embeddings like independent cloud services, regardless of where they run. Use `http://localhost:8765` for JEV and `http://localhost:11434` for Ollama with `qwen3-embedding:latest` during development on this machine. The implementation agent may use these services for live building and testing. Keep URLs configurable; containers need a reachable host address such as `host.docker.internal` with a Linux host-gateway mapping, or the inference machine's network address, rather than container localhost. Defer all model-residency management and GPU coordination.

Use a configurable 20-minute total HTTP request timeout for JEV, following its documented minimum of 1,200 seconds, and 10 minutes initially for embeddings. Allow for cold loading, provider queueing, and inference; increase JEV's deadline if other clients cause substantial queue waits because its server processing deadline starts only after queueing. Use a separate short connection-establishment timeout where supported. Ensure any proxy allows equally long requests; do not impose a shorter idle/response timeout accidentally. Pi requests also get a configurable long deadline.

Keep waiting work in application processing state, not in many open HTTP connections. Start with one in-flight inference request across the application's model calls, using the existing processing loop rather than a queue framework. Settings-page test calls use the same limiter. Measure request duration from dispatch, not while waiting locally. This only limits our application; it does not coordinate other clients or reserve GPU access.

Retry clearly transient connection failures and explicit throttling with bounded backoff, respecting Retry-After. A timeout after submission has an unknown outcome: record it for later retry rather than immediately sending another copy, because cancellation may not stop server-side computation. Save completed stages so restarting resumes unfinished work. Consider server-side admission control or asynchronous job APIs only if multiple applications later need shared queueing.

Group JEV work by identical question template and send each group consecutively with `X-AutoJev-Prefix-Cache: true`. Keep instructions, criteria, question/option ordering, and serialization stable; change only state between requests. Put story text, comparison candidates, and the interest profile in state rather than generating different instructions or criteria for each item. Use fixed judgments for matching, with candidate texts in state, instead of turning each candidate into a changing Choice option.

These are application-side batches of separate sequential HTTP requests, not one batch-job request or concurrent submissions. Process ready story-count requests together, then other ready template groups, respecting stage dependencies. Avoid alternating question templates per story. The documented cache retains one prefix for roughly five idle minutes; other clients, different questions, restarts, or model unloading can replace it. Cache misses affect performance, not correctness. No prewarm or GPU coordination is needed.

Test prefix-cache mode against original-order requests on representative messages before relying on it: enabling it changes prompt order and may change decisions. Log cached-token, cache-write-token, queue-duration, and request-ID response headers to verify reuse and diagnose latency. Reported input-token usage includes reused tokens, so it alone cannot measure savings. Keep a configuration switch to disable prefix caching.

Request a 2,048-token context for the tested Ollama embedding model and reject silent truncation. Separately cache completed embeddings and judgments by input, model, and prompt version; JEV's KV cache reuses computation, not answers. Repeated coverage should not trigger new research or summary generation unless it adds meaningful evidence.

## Stored records

Design the later schema around source-independent records:

- **Source:** a Telegram channel, email subscription, website, or feed. Keep connector type, access restrictions, and collection state separate from content.
- **Source item:** a post, email, or article with an internal ID, source-scoped external identity, original content, normalized text, publication and collection timestamps, and an optional original URL. Keep provider-specific fields in metadata or connector-specific records, not mandatory Telegram columns. Support edits and refetches without creating duplicate items.
- **Story mention:** an extracted event description tied to its source item and relevant text spans and links. One item can contain several mentions.
- **Story:** a source-independent event grouping mentions from any connector, with one current display version. Deduplication works across connectors.
- **Evidence:** fetched documents and links with provenance and access status. Primary-source status belongs to the relationship with a story, not to an entire website. Research-fetched documents need not belong to a subscribed source.

Also store embeddings, the judgments needed for processing, current summaries, processing status, and publication records. Publications reference stories, not Telegram input messages. Preserve original evidence so incorrect merges can be corrected; defer a full summary revision history.

Do not require every item to have a public URL or globally unique provider ID. Preserve collection provenance even when the same article arrives through Telegram, email, and a feed.

## Retention

Default to a configurable 14-day rolling history for deduplication, not a permanent news archive. Retain recent source items, mentions, embeddings, fetched evidence, and processing judgments only for this window. Use source publication time, falling back to first collection time when unavailable; refetches and duplicate reports must not indefinitely extend the life of older records. An active story can remain searchable through its recent mentions while older evidence expires.

Before publishing, save a self-contained publication snapshot with the headline, details summary or chosen excerpt, complete displayed source list, source labels and URLs, primary-source ordering/status, score if displayed, and any text needed for pagination. Keep the snapshot, stable callback identifier, Telegram destination/message IDs, and current view without automatic expiry. Buttons must render entirely from this snapshot, never depend on temporary history or embeddings. Copy required source data rather than leaving references that cleanup can delete. If a publication is deliberately updated, replace its snapshot only after preparing the complete new content.

Run daily cleanup with node-cron, separate from collection, and do not let it race an active processing/publication batch. Delete expired history, unused cached results, fetched page content, temporary files, and old completed processing records. Bound logs and prune abandoned failed batches after recording their failure. Keep source subscriptions, collection cursors, settings, credentials, and unfinished current work as operational state, not news history.

For stories without retained recent evidence, stop including them in duplicate search. Published snapshots survive, but are not a permanent deduplication index. After the window, an old story may be treated as new if it appears again; this is the accepted storage tradeoff.

PostgreSQL can reuse space from deleted rows; ordinary cleanup does not necessarily shrink its files immediately. Avoid scheduled blocking full-table compaction. Persistent publication snapshots will still grow with the number of published posts, but exclude embeddings and full fetched documents. Apply a separate bounded retention policy to backups so they do not become an indefinite raw-news archive.

## Reliability and access

Make ingestion and processing restartable with unique identifiers, saved progress, bounded retries, and stage-level status. Track publication attempts and reconcile uncertain sends rather than blindly reposting.

## Build order

1. Build the minimal two-service Compose setup and source tables, then interactive Telegram login, automatic channel discovery, and read-only live sample collection. Pause for the user to log in. Establish model connectivity and use real samples throughout subsequent steps. Keep source-item fields suitable for later email and web collectors without implementing them yet.
2. Implement story extraction and link association; evaluate on real channel messages.
3. Implement embeddings, duplicate judgments, and representative selection.
4. Add the React settings page with the editable interest profile and model configuration, then 1–10 scoring and bounded primary-source research and summarization.
5. Add scheduled publishing with durable snapshots and in-place headline/details/sources views. Add retention cleanup and test that buttons still work after all associated processing history is deleted. Finish retries and deployment instructions.
6. Run end-to-end trials and measure missed stories, false merges, unsupported summaries, and request latency before unattended operation.

## Implementation handoff

The project-root `.env` contains the supplied `TELEGRAM_BOT_TOKEN` and `JEV_API_KEY`, plus development endpoint URLs. It is owner-readable/writable only and excluded from Git and Docker build context. Use these credentials for authorized live tests without printing them. Pass them into the running application through Compose environment configuration, not image build arguments. The development localhost URLs must be adjusted for access from inside Docker. A handoff through Git alone will not include `.env`; transfer it separately and privately if the implementing agent runs elsewhere.

## Remaining implementation checks

Verify `gpt-6-luna` access and native structured output through Pi, test configured JEV/Ollama connectivity from the container, resolve the destination channel ID, and verify bot posting/editing permissions. Publication defaults to all eligible news regardless of interest score; no digest-size cap is specified.
