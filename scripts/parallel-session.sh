#!/usr/bin/env bash
# scripts/parallel-session.sh <persona> <n> [sessions] [--live]
#
# Run session <n> of a persona continuously, as one of several in parallel — or,
# with one session, an all-day loop for a single persona (discover → apply → repeat):
#
#   scripts/parallel-session.sh primary 1 1 --live   # one persona, all day, until killed
#
# DRY RUN UNLESS --live, like every other scheduled path: without it each round
# fills and screenshots forms and submits nothing.
#
#   scripts/parallel-session.sh primary 1 3 --live   # session 1 → persona "primary"
#   scripts/parallel-session.sh primary 2 3 --live   # session 2 → persona "primary2"
#   scripts/parallel-session.sh primary 3 3 --live   # session 3 → persona "primary3"
#   scripts/watchdog-sessions.sh primary 3 --live    # (re)start any that died — cron it
#
# Enable the clones first with PARALLEL_SESSIONS in src/personas.js
# (e.g. `primary: 3`) and log each extra profile in once:
#   node setup-browser-login.js primary2
#
# Every session is the same identity with its OWN Chrome profile and its own queue
# (queue-primary2.json, ...). They share the ledger, so duplicate checks hold across
# sessions — no two sessions apply to the same job, and core/company-cap.js treats
# primary2..N as the same persona group as primary.
#
# Only session 1 runs discovery, then splits the result across every session's queue
# (scripts/redistribute-queues.py). Two sessions discovering at once race each other
# into the same jobs.
#
# Pacing is env-tunable (APPLY_GAP_MS etc., see src/index.js). Linux/headless: the
# browser runs under scripts/with-display.sh.
set -u
MODE=(--dry-run)
ARGS=()
for a in "$@"; do
  case "$a" in
    --live)    MODE=(--live) ;;
    --dry-run) MODE=(--dry-run) ;;
    *)         ARGS+=("$a") ;;
  esac
done
BASE="${ARGS[0]:-}"
[ -n "$BASE" ] || { echo "usage: parallel-session.sh <persona> <n> [sessions] [--live]" >&2; exit 2; }
N="${ARGS[1]:-1}"
SESSIONS="${ARGS[2]:-$N}"
PERSONA="$BASE"
[ "$N" != "1" ] && PERSONA="${BASE}${N}"

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# Cron has a minimal PATH; find node the way an interactive shell would.
. scripts/lib/ensure-node.sh
LOG_DIR=".state/runs/logs"; mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/session-${PERSONA}.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [$PERSONA] $*" | tee -a "$LOG"; }

if ! node -e "process.exit(require('./src/personas').personas['$PERSONA'] ? 0 : 1)" 2>/dev/null; then
  echo "unknown persona \"$PERSONA\" — set PARALLEL_SESSIONS in src/personas.js (e.g. $BASE: $SESSIONS)" >&2
  exit 2
fi

log "=== session $N/$SESSIONS started (queue-${PERSONA}.json, ${MODE[0]}) ==="
ROUND=0
while true; do
  ROUND=$((ROUND + 1))
  TODAY=$(BASE="$BASE" node -e "
    const fs = require('fs');
    const day = new Date().toISOString().slice(0, 10);
    const base = process.env.BASE;
    let n = 0;
    try {
      for (const line of fs.readFileSync('.state/applications.ndjson', 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const a = JSON.parse(line);
          if (String(a.persona || '').replace(/\d+$/, '') === base && a.status === 'submitted' && String(a.ts || '').startsWith(day)) n++;
        } catch {}
      }
    } catch {}
    console.log(n);
  " 2>/dev/null || echo 0)
  log "round $ROUND | all $BASE sessions today: $TODAY submitted"

  if [ "$N" = "1" ]; then
    log "discovery (session 1 only)..."
    node src/discover-hn.js --if-empty >> "$LOG" 2>&1 || true   # fresh install: seed once
    # Four sources at once, capped at DISCOVERY_SEC (default 90s) so a slow board
    # never holds up applying. discover-ats.js takes QUERIES from the env, else the
    # persona's targetRoles.
    PERSONA="$BASE" TOKEN_CAP="${TOKEN_CAP:-300}" node src/discover-api.js >> "$LOG" 2>&1 &
    P1=$!
    PERSONA="$BASE" node src/discover-aggregators.js >> "$LOG" 2>&1 &
    P2=$!
    PERSONA="$BASE" node src/discover-community.js >> "$LOG" 2>&1 &
    P3=$!
    PERSONA="$BASE" bash scripts/with-display.sh node src/discover-ats.js >> "$LOG" 2>&1 &
    P4=$!
    T=0
    while [ "$T" -lt "${DISCOVERY_SEC:-90}" ]; do
      sleep 5; T=$((T + 5))
      kill -0 $P1 2>/dev/null || kill -0 $P2 2>/dev/null || kill -0 $P3 2>/dev/null || kill -0 $P4 2>/dev/null || break
    done
    kill $P1 $P2 $P3 $P4 2>/dev/null || true
    wait $P1 $P2 $P3 $P4 2>/dev/null || true
    [ "$SESSIONS" -gt 1 ] && { python3 scripts/redistribute-queues.py "$BASE" "$SESSIONS" >> "$LOG" 2>&1 || true; }
    log "discovery done"
  fi

  log "applying..."
  APPLY_GAP_MS="${APPLY_GAP_MS:-2000}" APPLY_JITTER_MS="${APPLY_JITTER_MS:-2000}" \
  APPLY_BREATHER_EVERY="${APPLY_BREATHER_EVERY:-30}" APPLY_BREATHER_MS="${APPLY_BREATHER_MS:-10000}" \
    bash scripts/with-display.sh bash scripts/nightly-run.sh "$PERSONA" "${MODE[@]}" \
      --max "${SESSION_MAX:-100}" --max-eval "${SESSION_MAX_EVAL:-300}" >> "$LOG" 2>&1 || true

  log "round $ROUND done"
  sleep "${SESSION_PAUSE_SEC:-15}"
done
