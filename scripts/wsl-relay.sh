#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
script="$root/scripts/wsl-relay.sh"
instance="${WSL_RELAY_INSTANCE:-default}"
[[ "$instance" =~ ^[a-z0-9_-]{1,32}$ ]] || { echo "Invalid relay instance."; exit 2; }
state="$root/tmp/wsl-relay-$instance"
mkdir -p -- "$root/tmp"
[[ ! -L "$state" ]] || { echo "Relay state cannot be a symlink."; exit 2; }
mkdir -m 700 -p -- "$state"
[[ -O "$state" ]] || { echo "Relay state must belong to the current user."; exit 2; }
chmod 700 "$state"

pid_matches() {
  local pid="$1" kind="$2" args uid
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  uid="$(ps -p "$pid" -o uid= 2>/dev/null)" || return 1
  [[ "${uid// /}" == "$UID" ]] || return 1
  args="$(ps -p "$pid" -o args= 2>/dev/null)" || return 1
  if [[ "$kind" == manager ]]; then
    [[ "$args" == *"$script __run"* ]]
  else
    [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" == "$root" ]] || return 1
    [[ "$args" == *"$root/scripts/wsl-inference-relay.mjs" || "$args" == *" tmp/wsl-inference-relay.mjs" ]]
  fi
}
read_pid() {
  local pid
  [[ -f "$1" && ! -L "$1" ]] || return 1
  read -r pid < "$1" || return 1
  pid_matches "$pid" "$2" || return 1
  printf '%s' "$pid"
}
rotate_log() {
  if [[ -f "$state/relay.log" ]] && (( $(stat -c %s "$state/relay.log") > 1048576 )); then
    mv -f -- "$state/relay.log" "$state/relay.log.1"
  fi
}

case "${1:-}" in
  start)
    adopt=""
    if (( $# > 1 )); then
      [[ $# == 3 && "$2" == --adopt ]] || { echo "Usage: $0 start [--adopt PID]"; exit 2; }
      pid_matches "$3" relay || { echo "Adoption requires a verified relay owned by this user."; exit 2; }
      adopt="$3"
    fi
    if pid="$(read_pid "$state/supervisor.pid" manager)"; then
      echo "Relay supervisor already running: $pid"; exit 0
    fi
    nohup bash "$script" __run "$adopt" </dev/null >/dev/null 2>&1 &
    for _ in {1..30}; do
      if pid="$(read_pid "$state/supervisor.pid" manager)"; then
        echo "Relay supervisor started: $pid. State/logs: $state"; exit 0
      fi
      sleep 0.1
    done
    echo "Relay supervisor did not start. Check state permissions and flock availability."
    exit 1
    ;;
  stop)
    if pid="$(read_pid "$state/supervisor.pid" manager)"; then
      kill -TERM "$pid"
      for _ in {1..100}; do
        pid_matches "$pid" manager || { echo "Relay supervisor stopped."; exit 0; }
        sleep 0.1
      done
      echo "Relay supervisor is still stopping."; exit 1
    fi
    echo "Relay supervisor is not running."
    ;;
  status)
    if pid="$(read_pid "$state/supervisor.pid" manager)"; then
      echo "Relay supervisor running: $pid"
      if child="$(read_pid "$state/child.pid" relay)"; then echo "Relay process running: $child"
      else echo "Relay is waiting to restart."; fi
    else echo "Relay supervisor is not running."; exit 1; fi
    ;;
  __run)
    command -v node >/dev/null
    command -v flock >/dev/null
    restart="${WSL_RELAY_RESTART_SECONDS:-2}"
    [[ "$restart" =~ ^([2-9]|[1-5][0-9]|60)$ ]] || exit 2
    exec 9>"$state/lock"
    flock -n 9 || exit 0
    cd "$root"
    printf '%s\n' "$$" > "$state/supervisor.pid"
    child="${2:-}"
    cleanup() {
      trap - EXIT TERM INT
      if [[ -n "$child" ]] && pid_matches "$child" relay; then
        kill -TERM "$child" 2>/dev/null || true
        for _ in {1..50}; do
          pid_matches "$child" relay || break
          sleep 0.1
        done
        if pid_matches "$child" relay; then kill -KILL "$child" 2>/dev/null || true; fi
      fi
      rm -f -- "$state/supervisor.pid" "$state/child.pid"
    }
    trap cleanup EXIT
    trap 'exit 0' TERM INT
    if [[ -n "$child" ]] && pid_matches "$child" relay; then
      printf '%s\n' "$child" > "$state/child.pid"
      printf 'Supervising existing relay %s until it exits.\n' "$child" >> "$state/relay.log"
      while pid_matches "$child" relay; do sleep 1; done
      child=""
    fi
    while true; do
      rotate_log
      node "$root/scripts/wsl-inference-relay.mjs" 9>&- >>"$state/relay.log" 2>&1 &
      child="$!"
      printf '%s\n' "$child" > "$state/child.pid"
      wait "$child" || true
      child=""
      rm -f -- "$state/child.pid"
      printf 'Relay exited; retrying in %s seconds.\n' "$restart" >> "$state/relay.log"
      sleep "$restart"
    done
    ;;
  *)
    echo "Usage: $0 <start [--adopt PID]|stop|status>"
    exit 2
    ;;
esac
