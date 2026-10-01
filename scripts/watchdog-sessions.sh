#!/usr/bin/env bash
# scripts/watchdog-sessions.sh <persona> <sessions>
#
# Restart any dead session of scripts/parallel-session.sh. Safe to run every few
# minutes from cron:
#
#   */5 * * * * cd /path/to/repo && bash scripts/watchdog-sessions.sh primary 3
set -u
BASE="${1:?usage: watchdog-sessions.sh <persona> <sessions>}"
SESSIONS="${2:?usage: watchdog-sessions.sh <persona> <sessions>}"
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
LOG_DIR=".state/runs/logs"; mkdir -p "$LOG_DIR"
for n in $(seq 1 "$SESSIONS"); do
  if ! pgrep -f "parallel-session.sh $BASE $n( |$)" > /dev/null 2>&1; then
    echo "[watchdog] $BASE session $n not running - starting"
    nohup bash scripts/parallel-session.sh "$BASE" "$n" "$SESSIONS" >> "$LOG_DIR/watchdog-$BASE.log" 2>&1 &
  fi
done
