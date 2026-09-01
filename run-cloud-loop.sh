#!/usr/bin/env bash
# Autonomous cloud apply loop: discover (Builtin) -> apply, repeat.
# Stops when SESSION_TARGET cloud apps are logged, or after 2 consecutive
# cycles add no new applications (fresh Builtin listings exhausted), or MAX_CYCLES.
set +e
cd "$(dirname "$0")"

TARGET=${TARGET:-50}
MAX_CYCLES=${MAX_CYCLES:-6}
DRY_LIMIT=2

count_cloud() { tail -n +2 applications-log.csv 2>/dev/null | grep -c '2026-06'; }
wait_chrome_free() { while [ "$(tasklist //FI 'IMAGENAME eq chrome.exe' //NH 2>/dev/null | grep -ci chrome.exe)" -ne 0 ]; do sleep 2; done; }

dry=0
start=$(count_cloud)
echo "=== CLOUD LOOP START — cloud apps so far: $start, target: $TARGET ==="

for cycle in $(seq 1 $MAX_CYCLES); do
  before=$(count_cloud)
  echo ""
  echo "########## CYCLE $cycle (cloud apps: $before/$TARGET) ##########"

  echo "--- discover (Builtin) ---"
  wait_chrome_free
  PERSONA=cloud MAX_PER_BOARD=60 node src/discover-boards.js 2>&1 | grep -E "builtin\]|total new|Queue now|BLOCKED" || true

  echo "--- apply ---"
  wait_chrome_free
  PERSONA=cloud SESSION_TARGET=$TARGET MAX_EVALUATED=200 node src/index.js 2>&1 | grep -E "✅ Applied|Session complete|Applied:|Skipped:|Errored:" || true

  after=$(count_cloud)
  echo "########## CYCLE $cycle DONE: $before -> $after cloud apps ##########"

  if [ "$after" -ge "$TARGET" ]; then echo "=== TARGET REACHED ($after) ==="; break; fi
  if [ "$after" -le "$before" ]; then dry=$((dry+1)); echo "(no new apps this cycle; dry=$dry/$DRY_LIMIT)"; else dry=0; fi
  if [ "$dry" -ge "$DRY_LIMIT" ]; then echo "=== STOPPING: $DRY_LIMIT dry cycles (fresh Builtin listings exhausted) ==="; break; fi
done

echo ""
echo "=== CLOUD LOOP END — cloud apps total: $(count_cloud) ==="
tail -n +2 applications-log.csv | grep '2026-06' | awk -F',' '{print "  "$2" | "$3}'
