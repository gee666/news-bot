# Daily Pi dependency updates

`scripts/pi-update.mjs` is a local updater. No Git remote is assumed and no timer is installed automatically. Both `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` keep literal `"latest"` in `package.json` and `package-lock.json`'s root dependencies. Exact resolved versions belong only in the lockfile's package entries.

Only the manifest and npm lockfile are promoted after validation. Active `node_modules` and builds stay untouched. npm is the supported package manager; do not generate a second pnpm lockfile. The updater never deploys, migrates a database, or restarts production.

## Run and validate

Use Node 24+, npm and a POSIX host, as the repository owner:

```sh
cd /var/www/workshop/oira666/news-bot
node scripts/pi-update.mjs --check  # Validate without promotion.
node scripts/pi-update.mjs
```

Options include `--root=/absolute/project/path`, `--timeout-seconds=900` and `--registry=https://registry.example.org/`. Each command defaults to ten minutes, with a maximum configurable limit of one hour. Registries must use unauthenticated HTTPS without URL credentials, query strings or fragments.

The updater retains the existing lockfile, changes only the two Pi specs to `"latest"` in the staged manifest, then runs:

```sh
npm update --package-lock-only --ignore-scripts \
  @earendil-works/pi-ai @earendil-works/pi-coding-agent
npm ci --ignore-scripts --include=dev
npm run --ignore-scripts typecheck
npm run --ignore-scripts lint
npm run --ignore-scripts test
npm run --ignore-scripts build
node --test scripts/*.test.mjs
```

npm update follows the manifest's tags and writes `"latest"` into the lock root. Candidate checks reject exact pins or ranges in either place, require exact resolved Pi versions in the lock package entries, and reject unrelated manifest changes. npm may change transitive lock entries. Every gate must pass; validation may not modify staged inputs. Lifecycle and pre/post hooks are disabled. Script-test filenames are expanded without a shell.

Staging lives entirely under project `tmp/`. Only manifests, build/test configs, `compose.yaml`, allowlisted code/fixtures in `src/`, `web/`, `migrations/` and `scripts/`, and the hash-pinned public tokenizer in `model-data/autojev-qwen35-tokenizer.json.gz` are copied. The tokenizer is public test metadata, not weights or runtime state; see `model-data/README.md`. No other model-data file is copied. Source directories must contain only code and public/synthetic fixtures.

Private `.env`, `.npmrc`, Pi auth, runtime/output directories and existing temporary data are excluded. Children get a fresh HOME, XDG directories, temporary directory and npm config/cache, without inherited credentials, proxies, `NODE_OPTIONS`, inference approval or database URLs. Missing lockfiles, local/git/linked dependencies, source symlinks and unrecognized tokenizer hashes fail closed. Database tests requiring `TEST_DATABASE_URL` skip; run those separately against a disposable database. Staging is not an OS sandbox for untrusted package code.

## Lock, status and recovery

`tmp/pi-update.lock` serializes runs. Overlap exits 75 without replacing the active job's status; other failures exit 1. Successful validation, updates and unchanged dependencies exit 0. Logs remain in `tmp/pi-update-*/events.log`; `tmp/pi-update-status.json` records phase, outcome, resolved versions and safe failure metadata. Child output and inherited environment values are never logged. Normal runs remove staging/cache/home; successful promotions retain original manifests and a journal in the run's `promotion/` directory.

Source hashes, permissions, inode identities and timestamps are checked after copying, before each rename and after promotion. Changes cancel the run. Other writers must honor the same directory lock or use a quiet maintenance window. These checks cannot eliminate the final race with an editor that ignores the lock. Do not run npm install/ci or read the manifest/lock pair for deployment during promotion or recovery.

POSIX cannot atomically replace two files together. Fsynced originals, candidates and a journal precede the two atomic renames. An interrupted promotion keeps the lock and can leave a mixed pair. To recover:

1. Stop only the updater's timer/service and concurrent source writers. Confirm the owner PID and child process group in `tmp/pi-update.lock/owner.json` have exited.
2. Inspect the journal and `.before` files, then run `node scripts/pi-update.mjs --recover`.

Recovery refuses live processes. A prepared journal restores originals only when both current files match original or candidate hashes; unrelated edits cause `recovery-conflict` without an initial write. Committed journals keep current files; a lock without a journal changes no manifests. Recovery archives the lock. Missing owner metadata, a crash-left `recovery` directory, PID reuse or conflicting edits require manual inspection, not blind lock deletion. Delete old completed logs and crash-left staging only while idle and after confirming no child remains.

## Current host schedule

The `oira666` user crontab has a daily 04:10 entry for this checkout, using `/home/oira666/.nvm/versions/node/v24.16.0/bin/node`. Output goes to `tmp/pi-update-cron.log`. If that Node installation moves, update its path with `crontab -e`.

The WSL host currently has no running cron daemon or systemd user manager. The entry is installed but cannot run until an administrator starts cron:

```sh
sudo service cron start
pgrep -a cron
crontab -l
```

Arrange for cron to start when WSL starts, or use the systemd timer below after enabling systemd. Do not enable both schedules. Cron does not catch up on missed runs while the host is off. The updater command and all validation gates have passed manually with Pi 1.1.0.

## Daily systemd user timer

Install these examples manually. Use a complete Node/npm installation outside HOME, such as `/opt/node24`. The updater puts the running Node binary's directory first in its clean PATH, so `/opt/node24/bin/npm` must exist alongside Node. `ProtectHome=yes` hides home-based Node installations and authentication. User namespace support is required for the filesystem restrictions.

Create `~/.config/systemd/user/news-bot-pi-update.service`:

```ini
[Unit]
Description=Validate and promote news-bot Pi dependency updates

[Service]
Type=oneshot
WorkingDirectory=/var/www/workshop/oira666/news-bot
ExecStart=/opt/node24/bin/node /var/www/workshop/oira666/news-bot/scripts/pi-update.mjs
TimeoutStartSec=80min
TimeoutStopSec=15s
KillMode=control-group
UMask=0077
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=/var/www/workshop/oira666/news-bot
ReadOnlyPaths=/var/www/workshop/oira666/news-bot/src /var/www/workshop/oira666/news-bot/web /var/www/workshop/oira666/news-bot/scripts /var/www/workshop/oira666/news-bot/migrations /var/www/workshop/oira666/news-bot/model-data /var/www/workshop/oira666/news-bot/node_modules
InaccessiblePaths=-/var/www/workshop/oira666/news-bot/.env -/var/www/workshop/oira666/news-bot/deploy -/var/www/workshop/oira666/news-bot/dist
StandardOutput=journal
StandardError=journal
```

Adjust Node and repository paths. Directory write access is needed for renames, not just access to the two existing files. Hide any additional private paths on your host. Never add `EnvironmentFile=.env` or live credentials. The job needs registry HTTPS and loopback sockets for mocked tests. Increase the total service timeout if you increase command timeouts.

Create `~/.config/systemd/user/news-bot-pi-update.timer`:

```ini
[Unit]
Description=Daily news-bot Pi dependency check

[Timer]
OnCalendar=*-*-* 04:10:00
RandomizedDelaySec=30min
Persistent=yes
Unit=news-bot-pi-update.service

[Install]
WantedBy=timers.target
```

After reviewing paths and sandbox support:

```sh
systemctl --user daemon-reload
systemctl --user enable --now news-bot-pi-update.timer
systemctl --user list-timers news-bot-pi-update.timer
journalctl --user -u news-bot-pi-update.service
```

Scheduling uses the host timezone and catches up after downtime. An administrator may need `loginctl enable-linger oira666` for runs without a login session. The host's systemd instance must still be running.
