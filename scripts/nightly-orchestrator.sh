#!/usr/bin/env bash
# scripts/nightly-orchestrator.sh — round-robin every persona toward its target.
#
#   scripts/nightly-orchestrator.sh --live          # e.g. from cron, nightly
#   PERSONAS="primary secondary" TARGET=40 scripts/nightly-orchestrator.sh --live
#   PRIORITY_PERSONA=secondary TARGET_SECONDARY=75 scripts/nightly-orchestrator.sh --live
#
# Linux (GNU date + flock), meant for a headless runner under cron. Without --live
# every round is a dry run, exactly as scripts/nightly-run.sh defaults.
#
# WHY ROUND-ROBIN
# Running each persona to completion before moving on means one persona that never
# reaches its target burns every round — about a day — while the personas after it
# never get a turn, and the run is still going when the next night's cron fires.
#
# Instead:
#   - one short round per persona per cycle, so every persona gets a turn early
#   - PRIORITY_PERSONA (optional) always goes first; the rest rotate daily so
#     nobody else is permanently last
#   - per-persona targets: TARGET_<PERSONA> (upper-case key) overrides TARGET
#   - each round's evaluation budget is capped (MAX_EVAL_CAP) to keep rounds short
#   - a hard deadline (RUN_HOURS, and never past NEXT_START_UTC minus 15 min) ends the run before the next night's cron
#   - a lock stops a second orchestrator starting while one is still live
#   - a persona whose nightly-run is already active (e.g. a leftover) is skipped
#   - "applied" counts submissions since THIS run started, not since UTC midnight,
#     so a run that crosses midnight doesn't reset its own progress
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1

TARGET="${TARGET:-50}"
MAX_ROUNDS="${MAX_ROUNDS:-8}"
MAX_EVAL_CAP="${MAX_EVAL_CAP:-150}"
RUN_HOURS="${RUN_HOURS:-22}"
# Daily cron start (UTC, HH:MM). The run stops 15 minutes before the next one.
NEXT_START_UTC="${NEXT_START_UTC:-01:00}"

LOG_DIR=".state/runs/logs"
mkdir -p "$LOG_DIR"

exec 9>".state/orchestrator.lock"
# Wait (up to 90 min) for a previous run to finish its last round rather than skipping the night.
if ! flock -w 5400 9; then
  echo "=== nightly-orchestrator: another run still holds the lock after 90 min - exiting ===" >&2
  exit 0
fi

# Optional: warn early if a profile has lost its Google session (it reads email codes).
python3 scripts/gmail-session-check.py 2>&1 | tee -a "$LOG_DIR/gmail-session-check.log" || true

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%S)"
START_EPOCH="$(date +%s)"
DEADLINE=$((START_EPOCH + RUN_HOURS * 3600))
# Never run into the next scheduled start: stop 15 minutes before it at the latest.
NEXT_CUTOFF=$(( $(date -u -d "$(date -u +%F) $NEXT_START_UTC" +%s) - 900 ))
[ "$NEXT_CUTOFF" -le "$START_EPOCH" ] && NEXT_CUTOFF=$((NEXT_CUTOFF + 86400))
[ "$NEXT_CUTOFF" -lt "$DEADLINE" ] && DEADLINE="$NEXT_CUTOFF"
SUMMARY_FILE="$LOG_DIR/orchestrator-$STAMP-summary.json"

notify() {
  [ -f "$SUMMARY_FILE" ] || return 0
  python3 scripts/notify-telegram.py "$SUMMARY_FILE" 2>>"$LOG_DIR/notify-$STAMP.err" || true
}
trap notify EXIT

LIVE_ARGS=(--dry-run)
EXTRA_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --live)    LIVE_ARGS=(--live) ;;
    --dry-run) LIVE_ARGS=(--dry-run) ;;
    *)         EXTRA_ARGS+=("$arg") ;;
  esac
done

# Which personas run: $PERSONAS (space-separated), else every persona in
# src/personas.js except parallel-session clones (primary2, primary3, ...).
if [ -n "${PERSONAS:-}" ]; then
  read -r -a BASE_PERSONAS <<< "$PERSONAS"
else
  read -r -a BASE_PERSONAS <<< "$(node -e "console.log(Object.keys(require('./src/personas').personas).filter((k) => !/\\d$/.test(k)).join(' '))")"
fi
# Rotate the starting persona by day so no persona is always last.
N=${#BASE_PERSONAS[@]}
OFF=$(( 10#$(date -u +%j) % N ))
PRIORITY_PERSONA="${PRIORITY_PERSONA:-}"
PERSONAS=()
[ -n "$PRIORITY_PERSONA" ] && PERSONAS+=("$PRIORITY_PERSONA")
for i in $(seq 0 $((N - 1))); do
  q="${BASE_PERSONAS[$(( (i + OFF) % N ))]}"
  [ "$q" = "$PRIORITY_PERSONA" ] || PERSONAS+=("$q")
done

# Per-persona target: TARGET_<PERSONA> (e.g. TARGET_PRIMARY=75), else TARGET.
target_for() {
  local var="TARGET_$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  echo "${!var:-$TARGET}"
}
echo "=== nightly-orchestrator: $STAMP (${LIVE_ARGS[*]}) order: ${PERSONAS[*]} deadline: $(date -u -d @"$DEADLINE" +%H:%MZ) ===" >&2

count_since_start() {
  local persona="$1"
  python3 - "$persona" "$START_ISO" <<'PY' 2>/dev/null || echo 0
import json, sys
persona, start = sys.argv[1], sys.argv[2]
n = 0
try:
    with open('.state/applications.ndjson') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                a = json.loads(line)
            except Exception:
                continue
            if a.get('persona') == persona and a.get('status') == 'submitted' and a.get('ts', '')[:19] >= start:
                n += 1
except Exception:
    pass
print(n)
PY
}

persona_busy() {
  pgrep -f "nightly-run.sh $1( |$)" >/dev/null 2>&1
}

run_discovery() {
  local persona="$1"
  local dlog="$LOG_DIR/orchestrator-$STAMP-${persona}-discover.log"
  echo "  [discovery] starting parallel discovery for $persona..." >&2
  # Browser hygiene before anything opens Chrome. Bot-scoring cookies re-accumulate
  # within hours, so this is the periodic guarantee that a profile never drifts far.
  # (no --profile: it resolves the persona's own dir, honouring a shared profileKey)
  PERSONA="$persona" node src/core/browser-hygiene.js >> "$dlog" 2>&1 9>&- || true
  # discover-api.js with TOKEN_CAP=500: sweeps 500 tokens per ATS (~60s) instead of all 9k+
  PERSONA="$persona" TOKEN_CAP=500 node src/discover-api.js >> "$dlog" 2>&1 9>&- &
  local api_pid=$!
  PERSONA="$persona" node src/discover-community.js >> "$dlog" 2>&1 9>&- &
  local comm_pid=$!
  PERSONA="$persona" node src/discover-aggregators.js >> "$dlog" 2>&1 9>&- &
  local agg_pid=$!
  local t=0
  while [ $t -lt 90 ]; do
    sleep 5; t=$((t+5))
    kill -0 $api_pid 2>/dev/null || kill -0 $comm_pid 2>/dev/null || kill -0 $agg_pid 2>/dev/null || break
  done
  kill $api_pid $comm_pid $agg_pid 2>/dev/null || true
  wait $api_pid $comm_pid $agg_pid 2>/dev/null || true
  echo "  [discovery] done for $persona" >&2
}

declare -A ROUNDS STATUS DONE DISCOVERED P_SECS
for p in "${PERSONAS[@]}"; do
  ROUNDS[$p]=0; STATUS[$p]=0; DONE[$p]=0; DISCOVERED[$p]=0; P_SECS[$p]=0
done

CYCLE=0
while [ "$CYCLE" -lt "$MAX_ROUNDS" ]; do
  CYCLE=$((CYCLE + 1))
  ACTIVE=0
  for p in "${PERSONAS[@]}"; do
    [ "${DONE[$p]}" -eq 1 ] && continue
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "  [deadline] reached - stopping before $p cycle $CYCLE" >&2
      break 2
    fi
    PT=$(target_for "$p")
    CURRENT=$(count_since_start "$p")
    NEED=$((PT - CURRENT))
    if [ "$NEED" -le 0 ]; then
      echo "  [$p] reached $PT - done" >&2
      DONE[$p]=1
      continue
    fi
    if persona_busy "$p"; then
      echo "  [$p] a nightly-run for $p is already active - skipping this cycle" >&2
      ACTIVE=1
      continue
    fi
    ACTIVE=1
    echo "--- [$p] cycle $CYCLE/$MAX_ROUNDS - $CURRENT/$PT applied, need $NEED ---" >&2
    T0=$(date +%s)
    if [ "${DISCOVERED[$p]}" -eq 0 ]; then
      run_discovery "$p"
      DISCOVERED[$p]=1
      sleep 3
    fi
    MAX_EVAL=$((NEED * 10 + 100))
    [ "$MAX_EVAL" -gt "$MAX_EVAL_CAP" ] && MAX_EVAL="$MAX_EVAL_CAP"
    PLOG="$LOG_DIR/orchestrator-$STAMP-$p"
    DIGEST="$(bash scripts/nightly-run.sh "$p" "${LIVE_ARGS[@]}" \
      --max "$NEED" --max-eval "$MAX_EVAL" \
      "${EXTRA_ARGS[@]}" 2>>"${PLOG}-round${CYCLE}.err" 9>&-)"
    STATUS[$p]=$?
    printf '%s\n' "$DIGEST" > "${PLOG}-round${CYCLE}.json"
    ROUNDS[$p]=$CYCLE
    P_SECS[$p]=$(( ${P_SECS[$p]} + $(date +%s) - T0 ))
    AFTER=$(count_since_start "$p")
    echo "  [$p] cycle $CYCLE done (exit ${STATUS[$p]}) - $AFTER/$PT (+$((AFTER - CURRENT)))" >&2
    [ "$AFTER" -ge "$PT" ] && DONE[$p]=1
    sleep 10
  done
  [ "$ACTIVE" -eq 0 ] && break
done

ALL_HIT=1
RESULT_LINES=()
for p in "${PERSONAS[@]}"; do
  FINAL=$(count_since_start "$p")
  PT=$(target_for "$p")
  [ "$FINAL" -lt "$PT" ] && ALL_HIT=0
  PLOG="$LOG_DIR/orchestrator-$STAMP-$p"
  RESULT_LINES+=("{\"persona\":\"$p\",\"exitCode\":${STATUS[$p]},\"durationSec\":${P_SECS[$p]},\"applied\":$FINAL,\"target\":$PT,\"rounds\":${ROUNDS[$p]},\"digestFile\":\"${PLOG}-round${ROUNDS[$p]}.json\",\"logFile\":\"${PLOG}-round${ROUNDS[$p]}.err\"}")
done

{
  printf '{"ranAt":"%s","mode":"%s","allHitTarget":%s,"results":[' \
    "$STAMP" "${LIVE_ARGS[*]}" "$( [ "$ALL_HIT" -eq 1 ] && echo true || echo false)"
  ( IFS=,; printf '%s' "${RESULT_LINES[*]}" )
  printf ']}\n'
} | tee "$SUMMARY_FILE"

echo "=== nightly-orchestrator done: $STAMP ===" >&2
