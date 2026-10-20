# Native Linux deployment

Use Docker Engine and Compose v2 on the remote host. Docker must already be enabled at boot. Spark runs the existing inference services externally. Do not install models on this host or run the WSL relay/startup scripts here.

## Cut over before enabling boot startup

The local app is still active during database migration. Do not run the installer or start the remote app yet. Installing enables startup on the next reboot, even though it does not start anything immediately.

1. Disable Windows task `\NewsBot-WSL`, including future logon/retry startup. Disable any other project startup task, WSL watcher and project Pi-update cron entry. Verify local automation cannot restart production.
2. Stop the local app. Keep its DB and private state for rollback. If the migration snapshot predates shutdown, take and restore a final snapshot after shutdown or explicitly accept the lost writes. Never run both production apps.
3. Verify remote DB/schema and copied `telegram_sessions` and `pi_auth` volumes, including OAuth and usage-outbox state. Resolve ambiguous Telegram sends before retrying publication.
4. Privately configure reachable existing Spark URLs in `.env` and inspect saved DB inference profiles. Environment defaults only seed profiles once. Old `host.docker.internal:18765` and `:21434` settings describe WSL relays, not Spark. Check container reachability, private-inference policy, credentials and allowed hosts without installing models. Retain loopback-only UI/DB bindings.
5. Confirm images are already built/loaded and validate Compose without exposing secrets:

   ```sh
   cd /home/oira666/Work/news-bot
   newgrp docker <<'DOCKER'
   timeout 30 docker compose --project-name news-bot config --quiet
   timeout 30 docker compose --project-name news-bot images
   DOCKER
   ```

No output from `.env`, resolved Compose configuration or container environments should be pasted into reports.

## Install, then explicitly start

Only after those gates pass, run on the remote host:

```sh
sudo bash /home/oira666/Work/news-bot/scripts/install-linux-startup.sh
```

The installer checks shell/unit syntax, installs a root-owned helper and three units, reloads systemd, and enables `news-bot.service` and `news-bot-watchdog.timer`. It does not start or restart them or call Docker. There is no `--activate` flag. Reinstallation replaces the installed helper/units but does not restart active units.

Optional overrides are `sudo ROOT=/absolute/checkout SERVICE_USER=oira666 DOCKER_BIN=/usr/bin/docker bash /path/to/scripts/install-linux-startup.sh`. Defaults use the installer's checkout, user `oira666`, and Docker from PATH. Paths must not contain spaces or shell/systemd metacharacters. Templates in `deploy/systemd/` show the intended `/home/oira666/Work/news-bot` deployment.

After final cutover approval, explicitly start:

```sh
sudo systemctl start news-bot.service news-bot-watchdog.timer
systemctl status news-bot.service news-bot-watchdog.timer
systemctl list-timers news-bot-watchdog.timer
journalctl -u news-bot.service -u news-bot-watchdog.service --since today
```

Starting the app runs migrations and resumes saved work/publication maintenance. System services survive logout and SSH disconnection without user linger. For private web access, run on your workstation:

```sh
ssh -N -L 3000:127.0.0.1:3000 oira666@192.168.0.106
```

Open `http://127.0.0.1:3000`. Use the configured `WEB_PORT` on the remote side if changed. Do not expose the unauthenticated UI publicly.

## Recovery behavior

- Docker's existing `unless-stopped` policies recover crashed containers. Docker does not restart a container merely because it becomes unhealthy.
- The boot oneshot runs Compose with no build, pull or recreation. It waits for health and retries failures after one minute. It does not deploy configuration/image changes. Docker daemon restarts do not apply Compose dependency ordering; boot retry and health recovery handle startup failures.
- The timer first checks after three minutes of boot, then one minute after each watchdog run. Runs do not overlap through this timer. The helper checks DB, crawler, then app. Only a running `unhealthy` container with at least five minutes of uptime is restarted, with `--no-deps`. App recovery also requires healthy DB and crawler.
- Healthy, starting, stopped, missing and healthcheck-free containers are left alone by the watchdog. Compose boot can start stopped services again. Manual watchdog use supports `ROOT` and `DOCKER_BIN`; its root defaults to the script's parent directory. Installed units supply both explicitly.
- No Spark probe controls boot or watchdog recovery. A transient inference outage must not restart a healthy app. HTTP health checks DB/background startup, not every worker's progress. Persistent faults still need operator attention. A recovery restart can interrupt in-flight work after its 30-second stop timeout.

For intentional maintenance or rollback, disable/stop automation before explicitly stopping containers:

```sh
sudo systemctl disable --now news-bot-watchdog.timer news-bot.service
# Separately stop the app through Compose using Docker-authorized access.
```

There is deliberately no unit ExecStop. Stopping the systemd oneshot does not stop Docker containers, and disabling it does not cancel Docker restart policies. Stopping the app explicitly leaves it stopped under `unless-stopped`. Stop remote production before reactivating local production.

## Acceptance and cleanup

Check container health, mounts, saved schedules and publication state. Close SSH and confirm unchanged app uptime after reconnecting. With approval, reboot and confirm boot recovery/timer operation. Test unhealthy recovery in a disposable stack first. During an approved Spark outage test, a healthy app's start time/restart count must remain unchanged.

Retain local rollback data until the final snapshot and remote restore are verified and reboot checks pass. Then remove only project-owned resources: `\NewsBot-WSL`, verified project relay processes, project cron entries, the three production containers and old project canaries, `news-bot_default`/`news-bot_crawler`, and reviewed project images/files. Verify PID identity before stopping relays. Never kill arbitrary WSL processes named Relay.

The local `news-bot_postgres_data`, `news-bot_pi_auth` and `news-bot_telegram_sessions` volumes contain private state. Back them up before deliberate removal. Anonymous volumes, shared base images, Docker globally and Windows model services are not blanket cleanup targets. Do not use global prune. Review checkout tmp snapshots/logs, private `.env`, and project-specific session records outside the checkout before retention or disposal. See the inspection inventory in remote `tmp/migration/operations-review.md` for observed candidates; recheck identities and current state before acting.
