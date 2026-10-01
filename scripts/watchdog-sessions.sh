#!/usr/bin/env bash
# scripts/watchdog-sessions.sh <persona> <sessions> [--live]
#
# Restart any dead session of scripts/parallel-session.sh. Safe to run every few
# minutes from cron. Sessions are dry runs unless --live is passed through:
#
#   */5 * * * * cd /path/to/repo && bash scripts/watchdog-sessions.sh primary 3 --live
set -u
BASE="${1:?usage: watchdog-sessions.sh <persona> <sessions> [--live]}"
SESSIONS="${2:?usage: watchdog-sessions.sh <persona> <sessions> [--live]}"
MODE="--dry-run"; [ "${3:-}" = "--live" ] && MODE="--live"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# Cron has a minimal PATH; find node the way an interactive shell would.
. scripts/lib/ensure-node.sh
LOG_DIR=".state/runs/logs"; mkdir -p "$LOG_DIR"
for n in $(seq 1 "$SESSIONS"); do
  if ! pgrep -f "parallel-session.sh $BASE $n( |$)" > /dev/null 2>&1; then
    echo "[watchdog] $BASE session $n not running - starting"
    nohup bash scripts/parallel-session.sh "$BASE" "$n" "$SESSIONS" "$MODE" >> "$LOG_DIR/watchdog-$BASE.log" 2>&1 &
  fi
done
