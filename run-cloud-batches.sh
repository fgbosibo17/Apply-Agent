#!/usr/bin/env bash
# Batch runner for the cloud-500 goal. A single long Playwright session degrades
# after ~30-50 jobs (submits get flaky → "No confirmation" errors, eventual hang).
# Running in small batches with a FRESH browser each keeps the session healthy.
# Loops until the cloud-applied total (goal window 2026-06-27+) reaches 500.
cd "$(dirname "$0")" || exit 1

TARGET_TOTAL=500
BATCH=25
SCRATCH="C:/Users/fopef/AppData/Local/Temp/claude/C--Users-fopef-OneDrive-Desktop-NewCode-QAJob/e1b5b06d-165d-4604-b0ad-a8812a4ce4bc/scratchpad"

count_applied() {
  node -e "const fs=require('fs');const l=fs.readFileSync('applications-log.csv','utf8').split(/\r?\n/).filter(Boolean);let c=0;for(const x of l.slice(1)){const cols=x.split(',');if(/(^|,| )cloud(,|\s*\$)/i.test(x)&&/applied/i.test(cols[6]||'')&&cols[0]>='2026-06-27')c++;}console.log(c);"
}

# Kill ONLY the cloudfs Chrome (by profile path in command line) — never the user's browser.
kill_cloudfs_chrome() {
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*browser-profile-cloudfs*' } | ForEach-Object { try { Stop-Process -Id \$_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }" >/dev/null 2>&1
}

for round in $(seq 1 25); do
  CUR=$(count_applied)
  echo "=== Round $round: cloud applied = $CUR / $TARGET_TOTAL  ($(date '+%H:%M:%S')) ==="
  if [ "$CUR" -ge "$TARGET_TOTAL" ]; then echo "TARGET REACHED ($CUR)"; break; fi
  NEED=$((TARGET_TOTAL - CUR))
  T=$BATCH; [ "$NEED" -lt "$BATCH" ] && T=$NEED
  kill_cloudfs_chrome
  rm -f browser-profile-cloudfs/SingletonLock browser-profile-cloudfs/SingletonCookie browser-profile-cloudfs/SingletonSocket 2>/dev/null
  echo "--- batch $round: target $T submissions ---"
  # MAX_EVALUATED kept LOW (45) so each browser session stays under the ~50-job
  # degradation threshold (beyond it, submits get flaky → "No confirmation" + hangs).
  # A fresh browser every ≤45 jobs keeps the session healthy.
  PERSONA=cloud BROWSER_PROFILE=browser-profile-cloudfs3 SESSION_TARGET=$T MAX_EVALUATED=45 CAPTCHA_HITL= node src/index.js > "$SCRATCH/cloud-batch-$round.log" 2>&1
  echo "--- batch $round done: $(grep -c '✅ Applied' "$SCRATCH/cloud-batch-$round.log" 2>/dev/null) applied this batch ---"
  kill_cloudfs_chrome
  sleep 3
done

echo "=== ALL DONE. Final cloud applied: $(count_applied) ==="
