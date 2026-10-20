#!/usr/bin/env bash
set -euo pipefail
root="${ROOT:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)}"
docker="${DOCKER_BIN:-docker}"
cd -- "$root"
compose=("$docker" compose --project-name news-bot)

state() {
  local id
  id=$(timeout 10 "${compose[@]}" ps --all --quiet "$1") || return 1
  if [[ -z "$id" ]]; then printf 'missing\n'; return; fi
  # This deployment has one container per service. Never inspect multiple IDs.
  [[ "$id" != *$'\n'* ]] || { echo "Multiple containers for $1; refusing recovery." >&2; return 1; }
  timeout 10 "$docker" inspect --format \
    '{{.State.Running}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.State.StartedAt}}' "$id"
}

for service in db crawl4ai app; do
  snapshot=$(state "$service")
  read -r running health started <<< "$snapshot"
  [[ "$running" == true && "$health" == unhealthy ]] || continue
  # Allow five minutes after each start, including repeated recovery attempts.
  started_epoch=$(date -d "$started" +%s)
  (( $(date +%s) - started_epoch >= 300 )) || continue
  if [[ "$service" == app ]]; then
    dependencies_ready=true
    for dependency in db crawl4ai; do
      snapshot=$(state "$dependency")
      read -r dep_running dep_health _ <<< "$snapshot"
      if [[ "$dep_running" != true || "$dep_health" != healthy ]]; then
        dependencies_ready=false
      fi
    done
    [[ "$dependencies_ready" == true ]] || continue
  fi
  printf 'Restarting unhealthy service %s\n' "$service"
  timeout 45 "${compose[@]}" restart --no-deps --timeout 30 "$service"
done
