# Personal news bot

A single-user Telegram news collector with a Russian digest and a React settings page. Production runs on native Linux with three Compose services: the Node app, PostgreSQL 17 with pgvector, and a private Crawl4AI browser-fetch service. JEV, Ollama embeddings and Pi's OpenAI Codex provider are external inference services.

## Requirements

- Docker Engine with the Compose v2 plugin and Docker access for the deployment user.
- Node 24 or newer and npm for development.
- A Telegram user account, Telegram API ID/hash, and an administrator bot for the destination channel.
- Reachable JEV and embeddings services. Defaults are JEV port 8765 and Ollama port 11434 with `qwen3-embedding:latest`.
- Codex OAuth access to `gpt-6-luna`.

Boot startup and unhealthy-container recovery use `news-bot.service` and `news-bot-watchdog.timer`. See [Linux deployment](docs/linux-deployment.md).

## Configure

For a new installation only:

```sh
cp -n .env.example .env
chmod 600 .env
```

Fill in secrets privately, including strong random values for `POSTGRES_PASSWORD` and `CRAWL4AI_API_TOKEN`. Never commit `.env`, paste tokens into command arguments, dump container environments, or run `docker compose config` without `--quiet`. Changing `.env` does not rotate an existing PostgreSQL password.

Database and UI ports bind to host loopback. Defaults are 5432 and 3000; set `DB_PORT` or `WEB_PORT` if occupied. Containers always use `db:5432`. Crawl4AI has no published host port. The app uses its private Compose address automatically. See [crawler configuration and isolation](deploy/crawl4ai/README.md).

`JEV_DOCKER_URL` and `EMBEDDING_DOCKER_URL` must be reachable from the app container, not container localhost. Linux maps `host.docker.internal` through `host-gateway`. Bind host inference services to a reachable interface and restrict access. Environment model/profile defaults seed the database only once; later changes use the settings UI.

## Deploy a new version

Back up private state and retain the previous images before upgrades. From the deployment checkout:

```sh
docker compose build app crawl4ai
docker compose up -d --wait db
docker compose run --rm app npm run migrate:production
docker compose up -d --wait app crawl4ai
```

Restarting resumes saved work and publication maintenance. The systemd boot service does not build or deploy new images.

## Telegram and Pi onboarding

Telegram login is interactive. Phone number, code and 2FA password are hidden:

```sh
docker compose run --rm app npm run cli:production -- login
docker compose run --rm app npm run cli:production -- discover
docker compose run --rm app npm run cli:production -- smoke --limit 2 --channels 2
```

Discovery resolves the destination to its numeric ID, imports subscribed broadcast channels, and excludes that destination. Repeat it to refresh subscriptions; manual source disabling is preserved. Smoke does not join channels, mark messages read or publish. Its output can contain private content. Do not commit it or send it to external inference without approval. See [Telegram setup](src/telegram/README.md).

Open `http://127.0.0.1:3000`, or the configured web port. For remote access, use an SSH tunnel rather than exposing the unauthenticated UI:

```sh
ssh -N -L 3000:127.0.0.1:3000 oira666@192.168.0.106
```

Use the UI to start Pi OAuth login and paste the provider redirect URL if the callback cannot reach the container. Tokens stay in the protected Pi volume. `NEWS_PI_MODEL` avoids inheriting a coding agent's unrelated `PI_MODEL`.

Scheduled publication starts disabled. With approval, verify bot send/edit permissions in the resolved destination:

```sh
docker compose run --rm -T --entrypoint node app --input-type=module <<'JS'
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

Enable publishing only after verification succeeds. New coverage of a story creates a complete cumulative edition, not a replacement for the old post. Related but distinct stories stay separate and link to each other.

## Settings and processing

New installations collect at 05:00, 09:00, 13:00, 17:00 and 21:00 in `Europe/Berlin`, with DST. Digest selection runs every three hours and cleanup at 04:00. Saved settings are not changed by these defaults. Publication minimum is 1/10, separate from the research threshold of 5/10. See [scheduling](docs/immediate-publishing.md), [processing and retries](src/pipeline/README.md), and [delivery reliability](docs/news-reliability.md).

RSS/Atom feeds and publisher websites share the collector with Telegram. Configure source identity, allowed paths, article budgets, backlog and retries in the source settings panel. Unknown publication dates are skipped unless `collect_once` is explicitly enabled; collected undated items retain null publication dates. Disabling a source preserves history. See [source collection](src/sources/README.md).

Saved settings apply between batches. Embedding changes stage a pending configuration; search switches only after the retained corpus is re-embedded. JEV requests allow at least 20 minutes and embeddings default to 10 minutes. Keep proxy deadlines equally long. Private/unknown content stays out of external inference unless `ALLOW_PRIVATE_INFERENCE` is approved. Research blocks private/reserved destinations and does not bypass CAPTCHAs or logins. Preferred domains affect fetch order, not authority.

Use **Collect & publish now** in Activity for a bounded manual run. This can send real Telegram messages. See [limits and recovery](docs/run-now.md). For picture/video selection, ordering and durable delivery, see [media handling](docs/media.md).

## Development and checks

```sh
npm ci
npm run typecheck
npm run lint
npm test
node --test scripts/*.test.mjs
node scripts/test-db.mjs
npm run build
npm run dev
```

Development needs `PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD` matching PostgreSQL. Keep `HOST=127.0.0.1`. The database test wrapper reads owner-private `.env` and creates a separate `newsbot_test` database. Each integration suite migrates and removes a random schema. It does not migrate production or read news history, and test children receive no inference keys or Telegram credentials. Use `DB_TEST_NAME` for another disposable database or private `TEST_DATABASE_URL` for a pre-created one. Never put credentials in command arguments. The test user needs schema creation and pgvector installation permissions. `--db-only` runs just the foundation and database suites.

Migrations use checksums and an advisory lock. Add new migrations; never edit applied SQL. The healthcheck reads `/api/health` and checks DB/background startup, not paid inference. Docker alone does not restart unhealthy containers; the Linux watchdog handles that.

Update Pi with `npm install @earendil-works/pi-ai@latest @earendil-works/pi-coding-agent@latest`.
Run the checks above.
Commit `package-lock.json`.

## Backups and retention

Named volumes retain PostgreSQL, Telegram sessions and Pi credentials. `docker compose down` keeps them; `down -v` deletes them. Backups contain private news and credentials. Encrypt off-machine copies and never commit them.

For default database names:

```sh
umask 077
mkdir -p tmp/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T db pg_dump -U newsbot -d newsbot -Fc > "tmp/backups/newsbot-$stamp.dump"
docker compose run --rm -T --no-deps --entrypoint tar app -czf - -C /data pi telegram > "tmp/backups/private-state-$stamp.tgz"
find tmp/backups -maxdepth 1 -type f \( -name 'newsbot-*.dump' -o -name 'private-state-*.tgz' \) -mmin +10080 -delete
```

Stop the app before restoring. Use compatible PostgreSQL/pgvector versions and preserve private volume permissions:

```sh
docker compose stop app
docker compose exec -T db pg_restore -U newsbot -d newsbot --clean --if-exists --no-owner < tmp/backups/newsbot-YYYYmmddTHHMMSSZ.dump
```

Prune backups after each run and daily, including off-machine copies. Remove private smoke samples and test reports separately; do not indiscriminately delete `tmp/` or active auth/session state. Copied OAuth refresh tokens can affect the original session. Use the app's own login instead of sharing a writable developer auth file.

News history defaults to 14 days by original publication or first collection. Refetches do not extend retention. Unfinished work stays protected. Publication snapshots and delivery state do not expire with history. Cleanup lets PostgreSQL reuse space but does not shrink files automatically. Docker logs are bounded to three 10 MB files per service.
