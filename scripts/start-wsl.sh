#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
[[ $# == 0 || ( $# == 1 && "$1" == --watch ) ]] || { echo "Usage: $0 [--watch]"; exit 2; }
start_once() {
  if ! timeout 15 sg docker -c 'docker info >/dev/null 2>&1'; then
    echo "Docker Engine is not running or accessible. Start it as WSL root; the scheduled startup task does this."
    return 1
  fi
  bash "$root/scripts/wsl-relay.sh" start || return 1
  timeout 15 node "$root/scripts/wsl-inference-relay.mjs" --check || return 1
  timeout 15 node "$root/scripts/wsl-inference-relay.mjs" --check-upstreams || return 1
  printf -v command 'docker compose --project-directory %q up -d --wait --wait-timeout 120' "$root"
  if ! timeout 180 sg docker -c "$command"; then
    local app health
    app="$(timeout 10 docker compose --project-directory "$root" ps -q app)" || return 1
    health="$(timeout 10 docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app")" || return 1
    if [[ "$health" == unhealthy ]]; then
      echo "App health failed; restarting its workers before the scheduled task retries."
      timeout 30 docker compose --project-directory "$root" restart app || return 1
    fi
    return 1
  fi
}
if [[ $# == 0 ]]; then start_once; exit; fi
umask 077
instance="${WSL_STARTUP_INSTANCE:-default}"
[[ "$instance" =~ ^[a-z0-9_-]{1,32}$ ]] || { echo "Invalid startup instance."; exit 2; }
state="$root/tmp/wsl-startup-watch-$instance"
[[ ! -L "$state" ]] || { echo "Unsafe startup state directory."; exit 1; }
mkdir -m 700 -p "$state"
[[ -O "$state" ]] || { echo "Startup state must belong to this user."; exit 1; }
exec 8>"$state/lock"
flock -n 8 || { echo "Startup watcher already running."; exit 0; }
while true; do
  if [[ -f "$state/startup.log" ]] && (( $(stat -c %s "$state/startup.log") > 1048576 )); then
    mv -f "$state/startup.log" "$state/startup.log.1"
  fi
  if ! start_once >>"$state/startup.log" 2>&1; then
    echo "News bot startup/health check failed. See $state/startup.log; the scheduled task retries in one minute."
    exit 1
  fi
  sleep 30
done
