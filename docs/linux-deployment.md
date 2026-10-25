# Native Linux deployment

Production runs on this native Linux host with Docker Engine and Compose v2. Docker must be enabled at boot. Spark runs the existing inference services externally; do not install models on this host. Startup and recovery use `news-bot.service` and `news-bot-watchdog.timer`. There is no Pi auto-update timer or cron job.

## Before deploying

Back up the database, `telegram_sessions` and `pi_auth` volumes, including OAuth and usage-outbox state. Retain the previous images for rollback. Resolve ambiguous Telegram sends before retrying publication, and never run two production apps against the same destination.

Configure reachable Spark URLs privately and inspect saved DB inference profiles. Environment defaults seed profiles only once. Check container reachability, private-inference policy, credentials and allowed hosts. Retain loopback-only UI/DB bindings. See [Deploy a new version](../README.md#deploy-a-new-version) for the build, migration and startup commands.

Validate Compose without exposing secrets:

```sh
cd /home/oira666/Work/news-bot
docker compose --project-name news-bot config --quiet
docker compose --project-name news-bot images
```

Do not paste `.env`, resolved Compose configuration or container environments into reports.

## Install, then explicitly start

For a fresh installation, after configuration and state are verified:

```sh
sudo bash /home/oira666/Work/news-bot/scripts/install-linux-startup.sh
```

The installer checks shell/unit syntax, installs a root-owned helper and three units, reloads systemd, and enables `news-bot.service` and `news-bot-watchdog.timer`. It does not start or restart them or call Docker. There is no `--activate` flag. Reinstallation replaces the installed helper/units but does not restart active units.

Optional overrides are `sudo ROOT=/absolute/checkout SERVICE_USER=oira666 DOCKER_BIN=/usr/bin/docker bash /path/to/scripts/install-linux-startup.sh`. Defaults use the installer's checkout, user `oira666`, and Docker from PATH. Paths must not contain spaces or shell/systemd metacharacters. Templates in `deploy/systemd/` show the intended `/home/oira666/Work/news-bot` deployment.

Explicitly start the installed units when ready:

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

There is deliberately no unit ExecStop. Stopping the systemd oneshot does not stop Docker containers, and disabling it does not cancel Docker restart policies. Stopping the app explicitly leaves it stopped under `unless-stopped`. Stop the current production app before starting a rollback instance.

## Verification and cleanup

Check container health, mounts, saved schedules and publication state. Close SSH and confirm unchanged app uptime after reconnecting. With approval, reboot and confirm boot recovery/timer operation. Test unhealthy recovery in a disposable stack first. During an approved Spark outage test, a healthy app's start time/restart count must remain unchanged.

Retain rollback data until backups, deployment and reboot recovery are verified. Back up private volumes before deliberate removal. Review project-specific files and volumes individually; do not use global Docker prune or delete shared images and services. Keep private `.env`, auth/session state and retained snapshots protected.
