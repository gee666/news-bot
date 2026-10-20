#!/usr/bin/env bash
set -euo pipefail
[[ $# == 0 ]] || { echo "Usage: sudo [ROOT=/path SERVICE_USER=user DOCKER_BIN=/path/docker] bash $0" >&2; exit 2; }
[[ $EUID == 0 ]] || { echo "Run this installer with sudo after cutover approval." >&2; exit 1; }
source_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
root="$(cd -- "${ROOT:-$source_root}" && pwd -P)"
user="${SERVICE_USER:-oira666}"
docker="$(command -v "${DOCKER_BIN:-docker}")"
docker="$(readlink -f -- "$docker")"
# Restrict substitutions to literal systemd/sed-safe paths and user names.
[[ "$root" =~ ^/[a-zA-Z0-9_./-]+$ && "$docker" =~ ^/[a-zA-Z0-9_./-]+$ ]] || {
  echo "Project and Docker paths must contain only letters, digits, /, _, . and -." >&2; exit 2;
}
[[ "$user" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Invalid service user." >&2; exit 2; }
id "$user" >/dev/null
getent group docker >/dev/null
[[ -f "$root/compose.yaml" && -x "$docker" ]]
bash -n "$source_root/scripts/linux-watchdog.sh"
mkdir -p -- "$source_root/tmp"
stage="$(mktemp -d "$source_root/tmp/linux-startup-install-XXXXXX")"
trap 'rm -rf -- "$stage"' EXIT
for unit in news-bot.service news-bot-watchdog.service news-bot-watchdog.timer; do
  sed -e "s|/home/oira666/Work/news-bot|$root|g" \
      -e "s|/usr/bin/docker|$docker|g" \
      -e "s|^User=oira666$|User=$user|" \
      "$source_root/deploy/systemd/$unit" > "$stage/$unit"
done
# Verify the actual ExecStart helper exists before verifying the staged units.
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$source_root/scripts/linux-watchdog.sh" /usr/local/libexec/news-bot-watchdog
timeout 30 systemd-analyze verify "$stage/news-bot.service" "$stage/news-bot-watchdog.service" "$stage/news-bot-watchdog.timer"
for unit in news-bot.service news-bot-watchdog.service news-bot-watchdog.timer; do
  install -o root -g root -m 0644 "$stage/$unit" "/etc/systemd/system/$unit"
done
timeout 30 systemctl daemon-reload
timeout 30 systemctl enable news-bot.service news-bot-watchdog.timer
echo "Installed and enabled for next boot. Nothing was started."
echo "After local production is stopped and the final snapshot/state verified:"
echo "  sudo systemctl start news-bot.service news-bot-watchdog.timer"
