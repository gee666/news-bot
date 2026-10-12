#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if ! timeout 15 sg docker -c 'docker info >/dev/null 2>&1'; then
  echo "Docker Engine is not running or accessible. Start it in WSL before this command."
  exit 1
fi
bash "$root/scripts/wsl-relay.sh" start
timeout 15 node "$root/scripts/wsl-inference-relay.mjs" --check
printf -v command 'docker compose --project-directory %q up -d --wait --wait-timeout 120' "$root"
timeout 180 sg docker -c "$command"
