# Personal news bot

A single-user Telegram news collector with a Russian digest and a React settings page. Production runs three Compose services: the Node 24 app, PostgreSQL 17 with pgvector, and a private Crawl4AI browser-fetch service. JEV, Ollama embeddings and Pi's OpenAI Codex provider are external inference services.

## Requirements

- Docker Engine with the Compose v2 plugin. Docker Desktop is not required on Linux.
- Node 24 and npm for local development.
- A Telegram user account, Telegram API ID/hash, and an administrator bot for the destination channel.
- Reachable JEV and embeddings services. Defaults are JEV port 8765 and Ollama port 11434 with `qwen3-embedding:latest`.
- Codex OAuth access to `gpt-6-luna`. The application tracks Pi's `latest` releases. The npm lockfile records the last validated versions; the [daily updater](docs/pi-updates.md) tests new releases before accepting them.

On WSL2, run Docker Engine in the Linux distribution and enable its service. A fresh login applies Docker group membership. The commands below use `sg docker -c` so an older terminal session also works. macOS needs a Linux VM runtime such as Colima.

For native Linux boot and unhealthy-container recovery, see [Linux deployment](docs/linux-deployment.md). Install it only after stopping the old production app and verifying the final migration snapshot.

## Configure and build

Do not overwrite an existing private configuration:

```sh
cp -n .env.example .env
chmod 600 .env
```

Fill in secrets privately. Never paste tokens into command arguments, commit `.env`, dump container environments, or run `docker compose config` without `--quiet`. Generate the database password and Crawl4AI bearer token if either is missing. Existing values remain unchanged, and the generated values are never printed:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
let text = readFileSync('.env', 'utf8');
for (const key of ['POSTGRES_PASSWORD', 'CRAWL4AI_API_TOKEN']) {
  if (parseEnv(text)[key]) continue;
  const line = key + '=' + randomBytes(32).toString('hex');
  text = new RegExp('^' + key + '=.*$', 'm').test(text)
    ? text.replace(new RegExp('^' + key + '=.*$', 'm'), line) : text + '\n' + line + '\n';
  writeFileSync('.env', text, { mode: 0o600 });
}
JS
chmod 600 .env
timeout 600 sg docker -c 'docker compose build app crawl4ai'
timeout 180 sg docker -c 'docker compose up -d --wait db'
timeout 180 sg docker -c 'docker compose run --rm app npm run migrate:production'
```

Database and UI ports bind to host loopback only. Crawl4AI has no published host port; the app calls it at the internal Compose address `http://crawl4ai:11235`, so no URL setting is needed in production. The crawler image is pinned to Crawl4AI 0.9.4 by digest. Compose limits it to 1536 MiB RAM, 2 CPUs and 256 MiB shared memory, and accepts one crawl job at a time. Each job gets a fresh browser, with no user cookies or persistent browser session; crawler cache is disabled. Default host ports are 5432 and 3000; set `DB_PORT` or `WEB_PORT` if occupied. Containers always use `db:5432`. For remote access, forward the configured loopback ports through SSH rather than exposing the unauthenticated UI or PostgreSQL. For example, `ssh -N -L 3000:127.0.0.1:3000 -L 55432:127.0.0.1:55432 USER@HOST` matches this checkout's host ports. Changing an existing database's password in `.env` does not change the password inside PostgreSQL; rotate it explicitly through a private database connection.

`JEV_DOCKER_URL` and `EMBEDDING_DOCKER_URL` must be reachable from the container, not container localhost. Linux adds `host.docker.internal` through `host-gateway`; bind host inference services to a reachable interface and restrict access. `INFERENCE_HOST_GATEWAY` can override that address. Environment model/profile defaults seed the database only once. Later changes use the settings UI.

## Telegram and Pi onboarding

Telegram login is interactive. Phone number, code and 2FA password are hidden:

```sh
timeout 600 sg docker -c 'docker compose run --rm app npm run cli:production -- login'
timeout 180 sg docker -c 'docker compose run --rm app npm run cli:production -- discover'
timeout 180 sg docker -c 'docker compose run --rm app npm run cli:production -- smoke --limit 2 --channels 2'
```

Discovery resolves the destination to its numeric ID, imports subscribed broadcast channels, and excludes that destination. Repeat `discover` to refresh subscriptions; manual source disabling is preserved. Smoke reads recent messages without joining channels, marking them read or publishing. Its output can contain private content; do not commit it or send it to external inference providers without approval.

Start the app only after configuration and login. A restart automatically resumes collected work and publication maintenance. Back up the database and retain the previous image before upgrades.

For Windows-hosted inference in WSL, use `bash scripts/start-wsl.sh` from the WSL section below instead of direct Compose startup, so the managed relay is ready first:

```sh
timeout 180 sg docker -c 'docker compose up -d app'
timeout 30 sg docker -c 'docker compose ps'
```

Open `http://127.0.0.1:3000`, or your configured web port. Windows browsers using the WSL helper can instead open `http://localhost:3030`; see the forwarding section below. Use the UI to start Pi OAuth login and paste the provider redirect URL when the browser callback cannot reach the container. Tokens remain in the protected Pi volume, never in the browser. `NEWS_PI_MODEL` avoids inheriting a coding agent's unrelated `PI_MODEL`.

Scheduled publication starts disabled. With approval, this one-off command sends and edits a labeled verification post in the resolved destination:

```sh
timeout 180 sg docker -c 'docker compose run --rm -T --entrypoint node app --input-type=module' <<'JS'
import { db } from './dist/db.js';
import { verifyBot } from './dist/publishing/index.js';
try {
  const result = await verifyBot();
  console.log({ verified: result.verified });
  if (!result.verified) process.exitCode = 1;
} catch {
  console.error('Bot verification failed. Check destination, bot permissions and configuration.');
  process.exitCode = 1;
} finally { await db.end(); }
JS
```

Enable publishing in the UI only after verification succeeds. Every edition has a headline, full details and source links, without buttons. New coverage of the same story creates another complete edition; it does not replace an older post's contents. Related but distinct stories stay separate and link to one another at the bottom. Automatic publication never deletes older editions.

## Settings and processing

New-installation defaults collect at 05:00, 09:00, 13:00, 17:00 and 21:00 in `Europe/Berlin`, with DST-aware CEST/CET. Accepted current stories enter a durable ready queue and wait for digest selection. The default digest cron is `0 */3 * * *`, every three hours in the saved timezone. Each scheduled digest refreshes stories and source-only links, then selects current ready events even if the sweep yielded. Recovery continuations select new posts only after the sweep finishes. Maintenance checks every five seconds only for previously authorized sends, reconciliation, edits and replacement deletions. Cleanup remains at 04:00 local time. Existing saved settings are not changed. See [scheduled publishing and the operator schedule recommendation](docs/immediate-publishing.md). Publication minimum is 1/10; research threshold is separately 5/10. Pi writes a Russian summary and reviews it once. An unsupported draft gets at most one rewrite and re-review. The final summary is publishable regardless of the verdict. Posts start with a ten-dot interest bar; every non-empty review reason appears as `Заметки проверяющего: <причина>`. Pi errors retry per story with backoff, without blocking other stories. Old link-only notices are regenerated automatically. Lower-interest stories use supplied links only; higher-interest stories may use bounded additional research. See [delivery reliability and bounded backlog recovery](docs/news-reliability.md). Ads are excluded from displayed sources. Source-only reports contribute useful links. Enrichment of an already published event creates a new cumulative edition instead of editing its contents.

Only one processor/collector owns the pipeline lease at a time. Due collection slots and collected snapshots queue durably even while model work is paused. Cutoff, membership, stages and retries persist; a parked model failure cannot discard inputs or permanently stop new scheduled snapshots. Each failed item or story retries with bounded exponential backoff, including Pi failures. Saved successful extraction is final for its item revision. Waiting and failed batches never block later batches. Unknown Telegram sends require reconciliation, not blind reposting. See [automatic processing retries](src/pipeline/README.md).

### Source priority and attribution

Research distinguishes original announcements and firsthand accounts from secondary reporting. The summary uses the story's mentions and research material, with links to known sources. There is no claim inventory, authority audit or review admission gate. The minimum publication score still applies.

Research follows bounded original-article candidates before lower-priority supplied links, including article links in the requested social post. Existing page limits and access restrictions still apply. An unread or inaccessible original cannot confirm facts. Discovery-only reporting remains usable with honest attribution. Luna prompts retain full mention, report and document text. Network fetch byte limits still apply. Old notice generations do not count as finished. Normal refresh regenerates unpublished drafts; coverage of an already-sent story uses a new complete edition.

### Publisher sources

The app supports RSS/Atom feeds and publisher websites alongside Telegram. New installations default to five Berlin-local collection times. Existing saved schedules and source budgets remain unchanged. Operators can set 1 to 50 article attempts per source per cutoff; the five built-in OpenAI, Anthropic, Google AI, NVIDIA and Hugging Face sources still default to two each. Failed reads count toward the budget, and an attempted article is not read again at the same cutoff. Fresh discoveries run before blocked retries; every third continuing backlog batch reserves an edit check. Undated entries use discovery age for scheduling, never as publication. Updates create revisions. Further coverage of a published story creates a new cumulative edition rather than replacing the sent news text.

Discovered entries survive feed rotation in a bounded durable backlog. The source form exposes backlog capacity, default 200 and maximum 1000, and retry base delay, default 60 minutes. Retry delays double up to 12 hours; retry admission requires a later scheduled cutoff. The source list shows saved backlog, unresolved reads, safe failure codes, earliest retry cutoff and overflow drops. Entries expire outside the collection window. Overflow and entries that rotate out between polls can still lose coverage. Choose budgets and polling frequency deliberately; the app does not increase saved limits or schedules automatically.

The Hacker News button opens a new draft, not a request or a change to an existing subscription. Its preset uses external public article links, submission-date semantics, undated collect-once, 20 attempts, a 200-entry backlog and a 60-minute retry base. Review before saving. For existing HN feeds, edit those settings explicitly. HN RSS dates describe submissions, not article publication; `feedDateRole: 'submission'` preserves them as metadata rather than `published_at`. Old dated articles remain outside the news window, and undated articles retain null publication. Same-host links remain the default for other sources, and public-access, path-prefix and private-network restrictions still apply. An upstream OpenAI 403 is not repaired by bypassing those restrictions.

Manage sources in the app's source settings panel. Review publisher name, URL and allowed article path prefixes. Invalid source configuration is isolated; disable a broken source rather than deleting its history. After ingestion, source kind and URL are identity-locked. Add a replacement source instead of changing identity. Disabling collection does not delete collected items or posts. Unknown publication dates are skipped by default. `collect_once` is an explicit per-source option for collecting them once, with `published_at` left null. Changing `skip` to `collect_once` through the source editor recovers skipped IDs, including legacy unfinished batch cursors, without replaying retained already-collected undated items. Apply `migrations/160_source_collection_config_version.sql` before running the new collector; it fences checkpoints taken before source configuration edits without changing settings or item history. See [source collection details](src/sources/README.md) for bounds and recovery limits. Neither a curated publisher name nor a preferred domain automatically grants primary authority. Source availability or configuration is not proof that a production collection has run or that new articles have been published.

Saved settings apply between batches; a running batch retains its settings snapshot. Profile changes stale existing judgments, and digest preparation refreshes current profile/model judgments before selecting stories. Model/prompt versions separate cached results. Embedding changes stage a pending configuration; search switches only after the active corpus is re-embedded. The active embedding input version is `mention-chunks-v2`: full text is split into bounded 4096-byte chunks, provider context-limit rejections split further, and chunk vectors are combined with a byte-weighted normalized mean. Text is not truncated. Model, dimensions and input version are recorded with the embedding index; the default dimension is 4096. Any embedding-input change requires the guarded re-embedding process before search switches. JEV prefix caching defaults on and can be disabled in settings; it reuses computation, not saved answers. JEV requests allow at least 20 minutes; embeddings default to 10 minutes. Keep proxy deadlines equally long.

Processing uses per-unit automatic retries. Configure `requestMaxAttempts`, `retryBaseMs` and `retryMaxMs` in Settings. Migration `190_automatic_processing.sql` reopens legacy parked work. `193_simple_association.sql` retires the old association trackers and settings, and resumes source-only work. Neither deletes collected data or successful extraction results. There are no provider-health recovery overrides or operator-approval replay commands.

Private/unknown content stays out of external inference by default. Do not enable `ALLOW_PRIVATE_INFERENCE` without approval. Research uses bounded Bing RSS searches when direct links do not establish primary evidence. Optional `RESEARCH_SEARCH_URL` selects a public SearxNG-compatible JSON endpoint instead. Search results remain unverified candidates until fetched and assessed. `RESEARCH_PREFERRED_DOMAINS` is a comma-separated fetch-priority hint, not an authority assessment or automatic primary-source designation. Direct browser fetching can read JavaScript-rendered pages, but blocked pages, SPA error shells and HTTP errors are reported as fetch failures rather than treated as content. It does not bypass CAPTCHAs or private logins. Fetching blocks private/reserved destinations even when private inference is approved.

The crawler uses [Crawl4AI](https://github.com/unclecode/crawl4ai) (about 84,587 GitHub stars observed October 1). Firecrawl has more stars, but Crawl4AI fits this deployment's fully self-hosted setup and license requirements.

## WSL Windows-hosted inference and UI forwarding

WSL host localhost can reach Windows services while Docker's Linux gateway cannot. The checked-in host helper `scripts/wsl-inference-relay.mjs` bridges this gap without opening Windows listeners or changing firewall rules. It binds only a local Docker bridge address, forwards JEV port 18765 to host loopback 8765 and embeddings port 21434 to loopback 11434, and rewrites the upstream Host header for AutoJev. It streams requests without logging payloads or imposing a shorter inference deadline.

Set these container endpoint overrides privately in `.env`, then use the managed startup command:

```dotenv
JEV_DOCKER_URL=http://host.docker.internal:18765
EMBEDDING_DOCKER_URL=http://host.docker.internal:21434
```

```sh
bash scripts/start-wsl.sh
bash scripts/wsl-relay.sh status
```

The host helper needs Node 24, Bash, `flock` from util-linux and `ip` from iproute2. `start-wsl.sh` checks Docker, starts the relay supervisor, waits for the two model listeners and optional UI listener, then starts the Compose services. This listener check tests TCP readiness; the app's healthcheck verifies the API/database after Compose startup. It does not start Docker Engine or the Windows model services. It now checks both relay listeners and actual upstream TCP ports, so a running proxy cannot disguise a stopped model service. `wsl-relay.sh start` is idempotent and can be used separately. Its supervisor restarts a crashed relay and waits for Docker interfaces to become available. Logs and PID state are owner-private under `tmp/wsl-relay-default`; logs retain at most about 1 MB plus one rotated copy. Runtime state is disposable; executable scripts are checked in.

The bind address defaults to Docker's `docker0` IPv4 gateway, or another Docker bridge if `docker0` is absent. Configure `INFERENCE_RELAY_BIND` if needed; only local Docker addresses and loopback are accepted, never wildcard or LAN bindings. Listener ports are configurable through `JEV_RELAY_PORT` and `EMBEDDING_RELAY_PORT`; upstream loopback ports through `JEV_UPSTREAM_PORT` and `EMBEDDING_UPSTREAM_PORT`. `INFERENCE_CONNECT_TIMEOUT_MS` defaults to 10000. Set these non-secret environment variables before starting the supervisor and keep Compose endpoint ports and `INFERENCE_HOST_GATEWAY` consistent. Restart the supervisor after configuration changes.

### Windows browser access

On some WSL setups, Windows localhost forwarding cannot reach Docker's loopback-published port 3000 even while WSL requests succeed. A native WSL Node listener can provide a separate path. The same supervisor therefore also manages an optional HTTP forwarder:

- `WSL_WEB_FORWARD_PORT` defaults to 3030; set it to 0 to disable.
- The listener binds only `127.0.0.1`. It cannot bind a LAN or wildcard address.
- The target is always `127.0.0.1`, using `WSL_WEB_TARGET_PORT`, otherwise `WEB_PORT`, otherwise 3000. Choose a free forwarding port distinct from the target and model ports.
- These three port values are read from private, owner-only `.env` without sourcing shell commands or exporting secrets. Exported shell values override the file; no other file settings are loaded by the helper.
- Browser Host, Origin and CSRF headers are preserved. Default app security accepts loopback hosts on any port; an explicit custom `APP_ALLOWED_HOSTS` remains unchanged and can reject an unlisted forwarding port.
- Requests and responses stream without payload/header logging. Absolute URLs and proxy tunnels are not supported. This is local HTTP, not an HTTPS terminator.

After the managed helper is running, open `http://localhost:3030` or `http://127.0.0.1:3030` in Windows. Linux/WSL can still use the regular port 3000. Existing SSH forwarding should target the configured `WEB_PORT`, not the extra WSL listener.

For a helper already running older code, **wait until the batch is finished and all model/digest work is idle**. Stop any separately launched temporary proxy occupying 3030, then reload the supervisor from checked-in source:

```sh
# Only after verifying no in-flight model requests; this briefly stops both model relays.
timeout 30 bash scripts/wsl-relay.sh stop
timeout 10 bash scripts/wsl-relay.sh start
timeout 15 node scripts/wsl-inference-relay.mjs --check
bash scripts/wsl-relay.sh status
```

No app rebuild/restart is required for this host-only change. Starting an already-running supervisor does not reload its child or environment. Restart it after port changes, only when idle. From Windows, verify the API and then use the browser to check page load and settings reads:

```powershell
(Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:3030/api/status -TimeoutSec 10).StatusCode
```

If Windows still cannot reach the native listener, inspect WSL's existing networking/localhost-forwarding setup. These scripts do not change it or install firewall rules.

Stop the app before deliberately stopping the relay during ordinary shutdown, to avoid interrupting model requests:

```sh
timeout 30 sg docker -c 'docker compose stop app'
bash scripts/wsl-relay.sh stop
```

### Boot without systemd

Docker restart policies cannot boot WSL or start Docker Engine and the host relay. Install the checked-in Windows logon task from PowerShell, supplying the actual Node 24 executable installed in Linux:

```powershell
& '\\wsl.localhost\Debian\var\www\workshop\oira666\news-bot\scripts\install-wsl-startup.ps1' `
  -Distro Debian -LinuxUser oira666 -ProjectPath '/var/www/workshop/oira666/news-bot' `
  -NodeBin '/home/oira666/.nvm/versions/node/v24.16.0/bin/node' -StartNow
```

The task starts Docker as WSL root, then runs `start-wsl.sh --watch` as the Linux user in the foreground. Keeping `wsl.exe` active prevents terminal closure from leaving only detached daemons. The watcher checks the stack, restarts an unhealthy app, and exits on failure so Task Scheduler retries in one minute. Logs are bounded and private under `tmp/wsl-startup-watch-default/`. Installation is explicit and idempotent; no password, firewall or power-policy changes are made. Disable the task before deliberately shutting down this deployment.

Keep Windows awake and arrange Windows model-service startup separately. No program can publish while its host is asleep or powered off. After app restart, the latest missed collection slot within the saved collection window is queued automatically, without replaying every lost slot or duplicating an existing snapshot.

## Small immediate publication runs

Use **Collect & publish now** in Activity for a bounded collect, process and publication run without the digest schedule wait. Defaults are 3 sources, 20 input entries, 5 prepared stories and at most 5 new posts. The collected-only option processes fresh untouched pending revisions without fetching sources. Saved settings, validation holds and provider cooldowns still apply. This action can send real Telegram messages. See [limits, recovery and API](docs/run-now.md).

## Development and checks

```sh
npm ci
npm run typecheck
npm run lint
npm test
node --test scripts/*.test.mjs
npm run build
npm run dev
```

Development needs `PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD` matching the Compose database. Keep `HOST=127.0.0.1`. Run all tests with real PostgreSQL integration enabled through the checked-in wrapper:

```sh
node scripts/test-db.mjs
# Or just foundation and database integration suites:
node scripts/test-db.mjs --db-only
```

The wrapper reads owner-private `.env`, builds connection URLs internally from `POSTGRES_*` and `DB_PORT`, and creates a separate `newsbot_test` database if needed. It does not migrate production or access news history. Each integration suite migrates a random test schema and deletes it afterward. Test children receive no inference keys, Telegram credentials, auth-directory paths or private-inference approval. Passwords and URLs are redacted from output.

Use `DB_TEST_NAME` for another disposable database, or put `TEST_DATABASE_URL` in private `.env` to use a pre-created test database without requiring CREATE DATABASE permission. Never put credentials in command arguments. The integration user must be able to create schemas and install pgvector in that test database.

Migrations use checksums and an advisory lock. Add a new migration; never edit already-applied SQL. The runner installs pgvector in shared `public`, outside disposable test schemas.

The app healthcheck reads `/api/health` on container loopback. Database failures and worker-start failures return unhealthy while the management API remains available. Per-unit model errors and publication-maintenance failures are logged with safe codes, not provider payloads. This is not a paid model probe or a promise that every source is accessible. Docker alone does not restart an unhealthy container; the WSL watcher restarts the app before Task Scheduler retries.

## Backups and retention

Named volumes retain PostgreSQL, Telegram sessions and Pi credentials. `docker compose down` keeps them; `down -v` deletes them. Backups contain private news and credentials. Encrypt them before off-machine transfer and never commit them.

For default database names:

```sh
umask 077
mkdir -p tmp/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
timeout 180 sg docker -c 'docker compose exec -T db pg_dump -U newsbot -d newsbot -Fc' > "tmp/backups/newsbot-$stamp.dump"
timeout 180 sg docker -c 'docker compose run --rm -T --no-deps --entrypoint tar app -czf - -C /data pi telegram' > "tmp/backups/private-state-$stamp.tgz"
# Prune only these backup files after seven days. Apply the same limit off-machine.
timeout 30 find tmp/backups -maxdepth 1 -type f \( -name 'newsbot-*.dump' -o -name 'private-state-*.tgz' \) -mmin +10080 -delete
```

Stop the app before restoring. Use a compatible PostgreSQL/pgvector version, preserve the private volume permissions, and restore the dump into the intended database:

```sh
timeout 30 sg docker -c 'docker compose stop app'
timeout 180 sg docker -c 'docker compose exec -T db pg_restore -U newsbot -d newsbot --clean --if-exists --no-owner' < tmp/backups/newsbot-YYYYmmddTHHMMSSZ.dump
```

Run backup pruning after each backup and daily. Keep a bounded backup window, for example seven days, including encrypted/off-machine copies. Database cleanup does not delete host `tmp/` smoke samples, raw test reports, or backups; remove those separately after validation. Keep runtime auth/session copies and the active supervisor's state/log directory until deliberately decommissioned. Never indiscriminately delete all of `tmp/` while the supervisor is running. Copied OAuth refresh tokens can rotate and affect the original account session; replace test credentials through the app's own login rather than sharing a writable developer auth file.

News history defaults to 14 days by original publication time or first collection time. Refetches do not extend it. Unfinished work remains protected. Stories without retained mentions stop participating in duplicate search; a later reappearance may become a new story. Publication snapshots and delivery state never expire automatically and survive history deletion, so storage still grows with published posts. Cleanup allows PostgreSQL to reuse space; it does not automatically shrink files. Docker logs are bounded to three 10 MB files per service.

## Dependency updates

Use npm and `package-lock.json`; there is no separate pnpm lockfile. `npm run pi:update` updates both Pi packages together in isolated staging and accepts the lockfile only after typecheck, lint, tests and build pass. It does not deploy or restart production. See [scheduling and recovery](docs/pi-updates.md).

Run `npm audit` to check current advisories. Telegram's GramJS package is marked deprecated upstream.

### Images and videos

The existing matching comparison returns `same`, `related` or `unrelated` without an additional model call. Two reports are the same story only when both can safely carry the same specific headline without losing their main actor, action or meaning. A common topic, cause or consequence is not enough. OpenAI discovering a PHP vulnerability and Alderon shutting down a game because of that vulnerability are related stories, not editions of one story. Related stories keep separate summaries, source sets and media, with bidirectional navigation links at the bottom. Historical unclassified thread links are not evidence of sameness.

Each new same-story edition is self-contained: the full cumulative summary, every accumulated source link and links to all earlier verified same-story editions. Old posts receive an `UPD: <latest post URL>` header only after the new edition is fully delivered. No old posts are deleted. Full text is never squeezed into a media caption; Telegram overflow uses durable continuation replies without dropping text or links. All distinct source photos and videos across the event thread are delivered in compatible reply batches, with at most ten attachments per album, not per event. Exact duplicates require no model calls; cached visual decisions are reused across editions and deployments. Summarization receives text and up to ten still images, configurable with `MEDIA_SUMMARY_MAX_IMAGES`; that cap does not limit published attachments. Media bytes are temporary and expire within seven days. See [media handling](docs/media.md) for comparison rules, Telegram delivery and cleanup.
