#!/usr/bin/env bash
# scripts/stop-now.sh — stop whatever the agent is running on this machine, now.
#
#   bash scripts/stop-now.sh
#   ssh you@server "cd job-agent && bash scripts/stop-now.sh"     # from another computer
#
# 1. stops the loops that would start more rounds: the nightly orchestrator and
#    persona-push (for parallel sessions use scripts/stop-sessions.sh, which also
#    pauses their watchdog)
# 2. asks every open round with a live run to stop gracefully: the job in flight
#    finishes, the round closes, its locks are released
# 3. closes rounds whose run already died (a crash leaves them open) straight away
# 4. after STOP_WAIT_SEC (default 300) anything still open is stopped by force
#
# The schedule is untouched: cron starts the next night as usual.
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# shellcheck source=scripts/lib/ensure-node.sh
. scripts/lib/ensure-node.sh

loops=0
for pat in "nightly-orchestrator.sh" "persona-push.sh"; do
  if pgrep -f "bash .*scripts/$pat|scripts/$pat" >/dev/null 2>&1; then
    pkill -TERM -f "scripts/$pat" 2>/dev/null || true
    loops=$((loops + 1))
    echo "stopped the $pat loop"
  fi
done

# Open rounds, split by whether a live process still holds their profile lock.
#   prints: "<id> live" or "<id> orphan", one per line
open_rounds() {
  node -e '
    const rounds = require("./src/core/rounds");
    const locks = require("./src/core/locks");
    const { profileKeyFor } = require("./src/personas");
    for (const r of rounds.list().filter((x) => !x.completedAt)) {
      const key = r.profileKey || profileKeyFor(r.persona) || r.persona;
      const held = key ? locks.inspectProfile(key) : null;
      console.log(r.id + " " + (held && held.live && held.roundId === r.id ? "live" : "orphan"));
    }
  ' 2>/dev/null
}

ROUNDS="$(open_rounds)"
if [ -z "$ROUNDS" ] && [ "$loops" -eq 0 ]; then
  echo "nothing is running"
  exit 0
fi

while read -r id state; do
  [ -n "${id:-}" ] || continue
  if [ "$state" = "live" ]; then
    echo "stopping round $id (the job in flight finishes first)"
    node bin/apply-agent.js round stop --round "$id" --reason "stop-now.sh" >/dev/null 2>&1 || true
  else
    echo "closing round $id (its run is no longer alive)"
    node bin/apply-agent.js round stop --round "$id" --force --reason "stop-now.sh: run was not alive" >/dev/null 2>&1 || true
  fi
done <<< "$ROUNDS"

WAIT="${STOP_WAIT_SEC:-300}"
T=0
while [ -n "$(open_rounds)" ] && [ "$T" -lt "$WAIT" ]; do
  sleep 5; T=$((T + 5))
done

LEFT="$(open_rounds)"
if [ -n "$LEFT" ]; then
  while read -r id _; do
    [ -n "${id:-}" ] || continue
    echo "round $id still open after ${WAIT}s — stopping it by force"
    node bin/apply-agent.js round stop --round "$id" --force --reason "stop-now.sh" >/dev/null 2>&1 || true
  done <<< "$LEFT"
fi

if [ -n "$(open_rounds)" ]; then
  echo "some rounds are still open — check: npm run agent -- round locks" >&2
  exit 1
fi
echo "stopped. The next scheduled night will run as usual."
