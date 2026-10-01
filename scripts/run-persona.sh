#!/usr/bin/env bash
# Run a batch apply loop for one persona. Portable: macOS, Linux (headless or not),
# and Windows Git Bash.
#
#   scripts/run-persona.sh <persona> [target] [batch]
#   scripts/run-persona.sh secondary 40 20
#   npm run run:persona -- secondary 40 20
#
# This replaces the Windows-only run-cloud-loop.sh / run-cloud-batches.sh, which
# could not run anywhere but Git Bash on Windows:
#
#   * `tasklist //FI 'IMAGENAME eq chrome.exe' //NH` does not exist off Windows, and
#     it waited on ANY Chrome — so on a laptop with a browser open it blocked
#     forever. The wait below is scoped to the persona's own profile directory,
#     which is the only Chrome that can actually contend for the lock.
#   * progress came from `grep -c '2026-06'` over the legacy applications-log.csv:
#     a hardcoded month that has since gone stale. Progress now comes from the
#     ledger, scoped to this round, via bin/apply-agent.js.
#   * there was no way to run headful Chrome on a display-less server. The run goes
#     through scripts/with-display.sh, which adds `xvfb-run -a` only when needed.
#
# It calls src/run-loop.js, never src/index.js directly: the loop owns the watchdog
# that force-kills a hung batch's whole process tree, the browser-death abort, and
# the fresh-browser-per-batch behaviour that keeps a Playwright session from
# degrading past ~50 jobs.
#
# The Windows Task Scheduler entry points (install-schedule.bat, run-job-agent.bat,
# run-qa-loop.cmd, job-agent-schedule.xml) are untouched and still supported.

set -u

# Load .env so the model-backed half of the pre-submit review can reach the
# orchestrator. Without this the gate still runs its deterministic grounding layer
# but reports backend "none" — checking identity fields and nothing else, which is
# the quiet half-failure this line exists to prevent.
if [ -f .env ] && [ -z "${APPLY_AGENT_ENV_LOADED:-}" ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  export APPLY_AGENT_ENV_LOADED=1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root" >&2; exit 1; }

# --tailor is opt-in and can appear anywhere among the arguments. Without it the
# tailoring batch pass does not run at all: no model call, no tailored writes, base
# resumes upload exactly as they did before.
TAILOR_FLAG=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --tailor) TAILOR_FLAG=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]+"${ARGS[@]}"}"

PERSONA="${1:-}"
TARGET="${2:-40}"
BATCH="${3:-20}"

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") <persona> [target] [batch] [--tailor]

  persona   which identity and profile to run: $(known_personas | tr '\n' ' ')
  target    submissions to aim for in this run   (default 40)
  batch     submissions per fresh browser        (default 20)
  --tailor  tailor each resume to its posting before applying (off by default;
            needs the claude CLI or APPLY_AGENT_TAILOR_ENDPOINT — without either
            it falls back to base resumes and the run continues)

examples:
  $(basename "$0") secondary
  $(basename "$0") primary 100 25
  npm run run:persona -- adjacent 25 10

environment passed through to src/run-loop.js:
  MAX_EVAL           jobs evaluated per batch (default 45; keeps a session under
                     the ~50-job degradation threshold)
  MAX_ROUNDS         hard cap on batches (default 60)
  MAX_DRY_ROUNDS     consecutive zero-gain batches before stopping (default 4)
  BATCH_TIMEOUT_MS   watchdog timeout per batch (default 40m)
  DRY_RUN=1          fill forms and screenshot, never submit
EOF
}

# Personas come from src/personas.js so adding one does not need editing here.
known_personas() {
  node -e "console.log(Object.keys(require('./src/personas').personas).join('\n'))" 2>/dev/null
}

# Read one field out of a JSON document on stdin. Used to pull values out of
# bin/apply-agent.js output without making jq a prerequisite.
json_field() {
  node -e "
    let s='';
    process.stdin.on('data', (d) => { s += d; })
      .on('end', () => {
        try { const v = JSON.parse(s)['$1']; process.stdout.write(v === undefined || v === null ? '' : String(v)); }
        catch { process.stdout.write(''); }
      });
  " 2>/dev/null
}

# ── Portable "is Chrome still holding this profile?" ────────────────────────
# Replaces `tasklist //FI 'IMAGENAME eq chrome.exe' //NH`, which was Git-Bash-only
# and matched every Chrome on the machine. Chrome takes an exclusive lock on a
# profile directory, so the only process worth waiting for is one launched with
# --user-data-dir pointing at this persona's profile.
profile_holders() {
  local profile="$1"
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      # Windows: match on the command line, same predicate run-loop.js uses.
      powershell -NoProfile -Command \
        "@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*${profile}*' }).Count" \
        2>/dev/null | tr -d '[:space:]'
      ;;
    *)
      # macOS and Linux: pgrep is present on both. It exits 1 with no match, which
      # is not an error here.
      pgrep -f "user-data-dir=[^ ]*${profile}" 2>/dev/null | grep -c . || true
      ;;
  esac
}

wait_profile_free() {
  local profile="$1"
  local waited=0
  local limit="${PROFILE_WAIT_SECONDS:-120}"
  while :; do
    local n
    n="$(profile_holders "$profile")"
    [ -z "$n" ] && n=0
    [ "$n" -eq 0 ] 2>/dev/null && return 0
    if [ "$waited" -ge "$limit" ]; then
      # Not fatal: run-loop.js calls cleanProfile() before each batch, which kills
      # the holder and clears stale Singleton locks. Say so rather than hanging.
      echo "    warn: $n Chrome process(es) still holding $profile after ${limit}s — run-loop will clean the profile itself"
      return 0
    fi
    [ "$waited" -eq 0 ] && echo "    waiting for $n Chrome process(es) to release $profile ..."
    sleep 2
    waited=$((waited + 2))
  done
}

# ── Arguments ──────────────────────────────────────────────────────────────
if [ -z "$PERSONA" ] || [ "$PERSONA" = "-h" ] || [ "$PERSONA" = "--help" ]; then
  usage
  exit 2
fi
if ! known_personas | grep -qx "$PERSONA"; then
  echo "unknown persona: $PERSONA" >&2
  echo "expected one of: $(known_personas | tr '\n' ' ')" >&2
  exit 2
fi
case "$TARGET$BATCH" in
  *[!0-9]*) echo "target and batch must be whole numbers (got '$TARGET' and '$BATCH')" >&2; exit 2 ;;
esac
if [ "$TARGET" -lt 1 ] || [ "$BATCH" -lt 1 ]; then
  echo "target and batch must both be at least 1" >&2
  exit 2
fi

# The profile directory comes from the persona's profileKey, not its name: primary and
# adjacent are one identity on one browser account, so both resolve to
# browser-profile-primary. Asking personas.js keeps that in one place.
PROFILE="$(node -e "console.log(require('./src/personas').profileDirFor('$PERSONA'))" 2>/dev/null)"
PROFILE="$(basename "${PROFILE:-browser-profile-$PERSONA}")"
PROFILE_KEY="$(node -e "console.log(require('./src/personas').profileKeyFor('$PERSONA'))" 2>/dev/null)"

echo "=== run-persona: ${PERSONA} | target ${TARGET} | batch ${BATCH} ==="
echo "    repo:    $ROOT"
if [ "$PROFILE_KEY" != "$PERSONA" ]; then
  echo "    profile: $PROFILE (shared account, profileKey '$PROFILE_KEY')"
else
  echo "    profile: $PROFILE"
fi
if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  echo "    display: none — running headful Chrome under xvfb-run -a"
else
  echo "    display: ${DISPLAY:-native}"
fi
if [ "$TAILOR_FLAG" = "1" ]; then
  echo "    tailor:  ON — a batch pass runs before applying"
else
  echo "    tailor:  off (pass --tailor to enable)"
fi

# ── Open the round ─────────────────────────────────────────────────────────
# Done here, before any browser, because `round start` runs the blocking machine
# preflight (Node, deps, real Chrome, xvfb, disk, ledger, this persona's resume and
# browser profile). A machine that cannot succeed should not burn a queue slot, and
# the refusal is far cheaper to read here than mid-run.
echo ""
# An outer envelope (scripts/go.sh, scripts/nightly-run.sh) may already have opened the
# round and taken the lock and semaphore. Adopt it rather than opening a second one: a
# second `round start` on this host is refused by our OWN semaphore, which would turn the
# whole apply phase into a silent no-op.
if [ -n "${ROUND_ID:-}" ] && node bin/apply-agent.js round status --round "$ROUND_ID" > /dev/null 2>&1; then
  echo "--- using the round already open: $ROUND_ID ---"
  ROUND_STATUS=0
  ROUND_JSON=""
else
  echo "--- opening round (runs machine preflight) ---"
  ROUND_JSON="$(printf '{"persona":"%s","target":%s,"maxEvaluated":%s,"note":"run-persona.sh"}' "$PERSONA" "$TARGET" "${MAX_EVAL:-45}" \
    | node bin/apply-agent.js round start --stdin)"
  ROUND_STATUS=$?
  ROUND_ID="$(printf '%s' "$ROUND_JSON" | json_field id)"
fi

if [ "$ROUND_STATUS" -ne 0 ] || [ -z "$ROUND_ID" ]; then
  echo "$ROUND_JSON"
  echo ""
  # Which guard refused decides what the caller should do, so say it plainly rather
  # than leaving the operator to read the JSON.
  GUARD="$(printf '%s' "$ROUND_JSON" | json_field guard)"
  case "$GUARD" in
    host-semaphore)
      echo "Refused by the HOST SEMAPHORE: this machine is already running a browser session." >&2
      echo "  -> Wait for it to finish, or run this persona on the other machine." >&2
      ;;
    profile-lock)
      echo "Refused by the PROFILE LOCK: another run holds the '${PROFILE_KEY}' browser profile." >&2
      echo "  -> Wait for the holder, or run a persona on a different profile (secondary has its own)." >&2
      ;;
    *)
      echo "Refusing to run: the round could not be opened." >&2
      echo "  -> Every failure above carries a remedy. Full report: npm run doctor" >&2
      ;;
  esac
  if [ -n "$GUARD" ]; then
    echo "  Inspect holders:  npm run agent -- round locks" >&2
    echo "  If it is dead:    npm run agent -- round unlock --force --persona ${PERSONA}" >&2
  fi
  exit 1
fi
echo "    round: $ROUND_ID"

# ── Hand off to the batch loop ─────────────────────────────────────────────
wait_profile_free "$PROFILE"

echo ""
echo "--- src/run-loop.js (watchdog + fresh browser per batch) ---"
PERSONA="$PERSONA" \
COUNT_PERSONA="$PERSONA" \
ROUND_ID="$ROUND_ID" \
TARGET="$TARGET" \
BATCH="$BATCH" \
TAILOR="$TAILOR_FLAG" \
bash "$ROOT/scripts/with-display.sh" node src/run-loop.js
LOOP_STATUS=$?

# ── Report from the ledger, scoped to this round ────────────────────────────
echo ""
echo "--- round $ROUND_ID (from the ledger) ---"
node bin/apply-agent.js round status "$ROUND_ID" || true

SUBMITTED="$(node bin/apply-agent.js round status "$ROUND_ID" 2>/dev/null | json_field submitted)"
[ -z "$SUBMITTED" ] && SUBMITTED=0
echo ""
echo "=== run-persona done: ${SUBMITTED}/${TARGET} submitted as ${PERSONA} (loop exit ${LOOP_STATUS}) ==="

ATTENTION="$(node bin/apply-agent.js round status "$ROUND_ID" 2>/dev/null | json_field attentionOpen)"
if [ -n "$ATTENTION" ] && [ "$ATTENTION" != "0" ]; then
  echo "    $ATTENTION item(s) need you: npm run agent -- attention list"
fi

exit "$LOOP_STATUS"
