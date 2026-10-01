#!/usr/bin/env bash
# scripts/persona-push.sh <persona> <target> [max_rounds] [--dry-run]
#
# Run ONE persona on its own until it has <target> new submissions (counted from
# when this push started), outside the nightly orchestrator — for "get this persona
# to 75 today" without waiting for the night.
#
#   scripts/persona-push.sh primary 75
#   scripts/persona-push.sh primary 3 1 --dry-run     # rehearse: fill + screenshot, submit nothing
#
# A push is a deliberate human command, so it submits unless --dry-run is given.
#
# - lock per persona, so two pushes for the same persona can't overlap
# - waits (doesn't count a round) while an orchestrator round for the same
#   persona is already using its browser profile
# - stops after two rounds in a row with no gain, or after max_rounds
# - sends the usual end-of-run Telegram summary via notify-telegram.py (if configured)
# - Linux: uses flock and GNU timeout
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# Cron has a minimal PATH; find node the way an interactive shell would.
. scripts/lib/ensure-node.sh
MODE="--live"; ARGS=()
for a in "$@"; do [ "$a" = "--dry-run" ] && MODE="--dry-run" || ARGS+=("$a"); done
P="${ARGS[0]:?persona}"; TARGET="${ARGS[1]:?target}"; MAX_ROUNDS="${ARGS[2]:-12}"
LOG_DIR=".state/runs/logs"; mkdir -p "$LOG_DIR"
exec 8>".state/push-$P.lock"
flock -n 8 || { echo "push for $P already running"; exit 0; }

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
START_ISO="$(date -u +%Y-%m-%dT%H:%M:%S)"
T0=$(date +%s)
PLOG="$LOG_DIR/push-$STAMP-$P"
SUMMARY="$LOG_DIR/push-$STAMP-summary.json"
echo "=== persona-push: $P target $TARGET from $START_ISO ===" >&2

count() {
  python3 - "$P" "$START_ISO" <<'PY' 2>/dev/null || echo 0
import json, sys
p, s = sys.argv[1], sys.argv[2]
n = 0
for line in open('.state/applications.ndjson'):
    try: a = json.loads(line)
    except Exception: continue
    if a.get('persona') == p and a.get('status') == 'submitted' and a.get('ts', '')[:19] >= s:
        n += 1
print(n)
PY
}

PERSONA="$P" node src/core/browser-hygiene.js >> "$PLOG-discover.log" 2>&1 8>&- || true
node src/discover-hn.js --if-empty >> "$PLOG-discover.log" 2>&1 8>&- || true   # fresh install: seed once
( PERSONA="$P" TOKEN_CAP=500 timeout 120 node src/discover-api.js
  PERSONA="$P" timeout 90 node src/discover-community.js
  PERSONA="$P" timeout 90 node src/discover-aggregators.js ) >> "$PLOG-discover.log" 2>&1 8>&- || true

ROUND=0; STATUS=0; ZERO=0; DIGEST_FILE=""
while [ "$ROUND" -lt "$MAX_ROUNDS" ]; do
  CUR=$(count)
  [ "$CUR" -ge "$TARGET" ] && break
  if pgrep -f "nightly-run.sh $P( |$)" >/dev/null 2>&1; then
    echo "  [$P] another run is using the profile - waiting" >&2
    sleep 120; continue
  fi
  ROUND=$((ROUND + 1))
  NEED=$((TARGET - CUR))
  EVAL=$((NEED * 6 + 60)); [ "$EVAL" -gt 200 ] && EVAL=200
  echo "--- [$P] push round $ROUND - $CUR/$TARGET, need $NEED (eval cap $EVAL) ---" >&2
  DIGEST_FILE="${PLOG}-round${ROUND}.json"
  bash scripts/nightly-run.sh "$P" "$MODE" --max "$NEED" --max-eval "$EVAL" \
    > "$DIGEST_FILE" 2>>"${PLOG}-round${ROUND}.err" 8>&-
  STATUS=$?
  AFTER=$(count)
  echo "  [$P] round $ROUND done (exit $STATUS) - $AFTER/$TARGET (+$((AFTER - CUR)))" >&2
  if [ "$AFTER" -le "$CUR" ]; then ZERO=$((ZERO + 1)); else ZERO=0; fi
  [ "$ZERO" -ge 2 ] && { echo "  [$P] two rounds with no gain - stopping" >&2; break; }
  sleep 15
done

FINAL=$(count)
printf '{"ranAt":"%s","mode":"'"$MODE"'","results":[{"persona":"%s","exitCode":%s,"durationSec":%s,"applied":%s,"target":%s,"rounds":%s,"digestFile":"%s"}]}\n' \
  "$STAMP" "$P" "$STATUS" "$(( $(date +%s) - T0 ))" "$FINAL" "$TARGET" "$ROUND" "$DIGEST_FILE" > "$SUMMARY"
python3 scripts/notify-telegram.py "$SUMMARY" 2>>"$LOG_DIR/notify-$STAMP.err" 8>&- || true
echo "=== persona-push done: $P $FINAL/$TARGET ===" >&2
