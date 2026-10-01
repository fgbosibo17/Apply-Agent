#!/usr/bin/env bash
# scripts/stop-sessions.sh <persona> [--resume]
#
# Stop every parallel session of a persona cleanly, and keep the watchdog from
# restarting them:
#
#   scripts/stop-sessions.sh primary            # pause: finish jobs in flight, then stop
#   scripts/stop-sessions.sh primary --resume   # unpause: the watchdog restarts them
#
# 1. writes .state/sessions/<persona>.paused — scripts/watchdog-sessions.sh starts
#    nothing while it exists, and each session loop exits at its next round
# 2. asks every open round of the persona group (primary, primary2, ...) to stop
#    gracefully: the job in flight finishes, the round closes, its locks are released
# 3. waits up to STOP_WAIT_SEC (default 300) for the session loops to exit
# 4. anything still running is stopped by force (`round stop --force` kills the
#    browser's process group and closes the round), and the loops are terminated
set -u
BASE="${1:-}"
[ -n "$BASE" ] || { echo "usage: stop-sessions.sh <persona> [--resume]" >&2; exit 2; }
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# shellcheck source=scripts/lib/ensure-node.sh
. scripts/lib/ensure-node.sh

SESS_DIR=".state/sessions"
mkdir -p "$SESS_DIR"
MARKER="$SESS_DIR/$BASE.paused"

if [ "${2:-}" = "--resume" ]; then
  rm -f "$MARKER"
  echo "resumed: the watchdog will start $BASE's sessions on its next run"
  exit 0
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"
echo "paused $BASE: the watchdog will not restart its sessions (undo: $0 $BASE --resume)"

# Open rounds of this persona group, newest last.
open_rounds() {
  BASE="$BASE" node -e '
    const base = process.env.BASE;
    const inGroup = (p) => p === base || (p.startsWith(base) && /^[0-9]+$/.test(p.slice(base.length)));
    const rounds = require("./src/core/rounds").list();
    console.log(rounds.filter((r) => !r.completedAt && inGroup(r.persona || "")).map((r) => r.id).join(" "));
  ' 2>/dev/null
}

loops_running() {
  pgrep -f "parallel-session.sh $BASE [0-9]" >/dev/null 2>&1
}

ROUNDS="$(open_rounds)"
for id in $ROUNDS; do
  echo "  stopping round $id (graceful)"
  node bin/apply-agent.js round stop --round "$id" --reason "stop-sessions.sh" >/dev/null 2>&1 || true
done

WAIT="${STOP_WAIT_SEC:-300}"
T=0
while [ "$T" -lt "$WAIT" ]; do
  [ -z "$(open_rounds)" ] && ! loops_running && break
  sleep 5; T=$((T + 5))
done

for id in $(open_rounds); do
  echo "  round $id still open after ${WAIT}s — stopping it by force"
  node bin/apply-agent.js round stop --round "$id" --force --reason "stop-sessions.sh" >/dev/null 2>&1 || true
done

# The loops: their own process groups when the watchdog started them with setsid,
# otherwise the processes themselves.
for pidfile in "$SESS_DIR/$BASE"-*.pid; do
  [ -f "$pidfile" ] || continue
  pid="$(cat "$pidfile" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
done
pkill -TERM -f "parallel-session.sh $BASE [0-9]" 2>/dev/null || true
sleep 2

if loops_running || [ -n "$(open_rounds)" ]; then
  echo "some sessions are still shutting down — check: npm run agent -- round locks" >&2
  exit 1
fi
echo "all $BASE sessions stopped"
