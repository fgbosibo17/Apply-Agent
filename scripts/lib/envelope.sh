#!/usr/bin/env bash
# The shared envelope for every way into a run.
#
# There are three ways in — a schedule, a chat command, and a human at a keyboard — and
# they differ ONLY in who decided and when. Everything else is identical: take the lock,
# sync state, run, release, emit a digest. Sourced by scripts/nightly-run.sh and
# scripts/go.sh so the two cannot drift apart.
#
# ── TWO INVARIANTS, AND THEY ARE NOT NEGOTIABLE ────────────────────────────
#
#   1. STDOUT IS THE JSON CONTRACT. Exactly one JSON document is written to stdout, at
#      the very end, on every path including every failure. A crashed run that reports
#      nothing is worse than one that reports failing: the orchestrator cannot tell the
#      first from a hung run. So all human-readable progress goes to stderr, and all
#      verbose output goes to .state/runs/logs/.
#
#   2. THE LOCK IS ALWAYS RELEASED. An open round holds its profile lock until the
#      staleness threshold expires, which would refuse tonight's run for a job that is
#      already over. `finish` runs from an EXIT trap, so it runs on success, on failure,
#      on an unexpected error, and on Ctrl-C.
#
# Fully non-interactive: no prompts, no pagers, and anything that might read stdin gets
# </dev/null. A scheduled run has no terminal to answer with.

set -u
set -o pipefail

AGENT="node bin/apply-agent.js"

# ── state ──────────────────────────────────────────────────────────────────
ENV_ROUND_ID=""
ENV_PERSONA=""
ENV_STAGE="startup"
ENV_FAILED=0
ENV_ERROR=""
ENV_DIGEST_EMITTED=0
ENV_LOG=""

# Human-readable progress. stderr, never stdout.
say()  { printf '%s\n' "$*" >&2; }
step() { ENV_STAGE="$1"; printf '\n==> [%s] %s\n' "$1" "${2:-}" >&2; }

# Record a failure and stop. The EXIT trap emits the digest and releases the lock.
die() {
  ENV_FAILED=1
  ENV_ERROR="$*"
  say "FAILED at ${ENV_STAGE}: $*"
  exit 1
}

# Run a command with its verbose output captured to the round log, not stdout.
# Usage: logged <label> <command...>
logged() {
  local label="$1"; shift
  if [ -n "$ENV_LOG" ]; then
    printf '\n===== %s : %s =====\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" >> "$ENV_LOG"
    "$@" >> "$ENV_LOG" 2>&1 < /dev/null
  else
    "$@" > /dev/null 2>&1 < /dev/null
  fi
}

# Run a command that emits JSON we want to keep, returning it on OUR stdout capture.
# Verbose stderr still goes to the log.
json() {
  if [ -n "$ENV_LOG" ]; then
    "$@" 2>> "$ENV_LOG" < /dev/null
  else
    "$@" 2>/dev/null < /dev/null
  fi
}

# The same two, for commands that READ a payload piped into them (`--stdin`).
#
# logged/json above take stdin from /dev/null so a command can never sit waiting on a
# terminal — but that redirect also REPLACES a pipe. `printf payload | json cmd --stdin`
# therefore handed every --stdin command an empty document: rounds started with no
# persona, so the profile lock and host semaphore were never taken and preflight was
# never scoped. These leave stdin alone; use them only where a payload is piped in.
logged_stdin() {
  local label="$1"; shift
  if [ -n "$ENV_LOG" ]; then
    printf '\n===== %s : %s =====\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$label" >> "$ENV_LOG"
    "$@" >> "$ENV_LOG" 2>&1
  else
    "$@" > /dev/null 2>&1
  fi
}
json_stdin() {
  if [ -n "$ENV_LOG" ]; then
    "$@" 2>> "$ENV_LOG"
  else
    "$@" 2>/dev/null
  fi
}

# Read one field out of a JSON document on stdin, without requiring jq.
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

# Open the round log once the round id is known, so logs are addressable per round.
open_log() {
  local dir
  dir="$(node -e "process.stdout.write(require('./src/core/paths').runLogs())" 2>/dev/null)"
  if [ -n "$dir" ]; then
    ENV_LOG="${dir}/${ENV_PERSONA:-run}-${ENV_ROUND_ID:-nordid}-$(date -u +%Y%m%dT%H%M%SZ).log"
    : > "$ENV_LOG"
    chmod 600 "$ENV_LOG" 2>/dev/null || true
    say "    log: $ENV_LOG"
  fi
}

# ── the exit path ──────────────────────────────────────────────────────────
#
# Always: close the round (which releases both guards), then emit exactly one digest.
finish() {
  local code=$?
  trap - EXIT

  # 1. Close the round. rounds.complete releases the profile lock and the host
  #    semaphore; unlock --force is the backstop for the case where the record cannot be
  #    written at all. Never leave a lock held.
  if [ -n "$ENV_ROUND_ID" ]; then
    if [ "$ENV_FAILED" = "1" ] || [ "$code" != "0" ]; then
      printf '{"id":"%s","note":"%s"}' "$ENV_ROUND_ID" "aborted at ${ENV_STAGE}" \
        | logged_stdin "round complete (aborted)" $AGENT round complete --stdin || true
    fi
    # Belt and braces: if the round record could not be closed, break the guards anyway.
    local held
    held="$(json $AGENT round locks | json_field machineId || true)"
    if [ -n "$held" ] && [ -n "$ENV_PERSONA" ]; then
      logged "unlock backstop" $AGENT round unlock --force --persona "$ENV_PERSONA" || true
    fi
  fi

  # 2. Exactly one digest on stdout, whatever happened.
  if [ "$ENV_DIGEST_EMITTED" = "0" ]; then
    ENV_DIGEST_EMITTED=1
    if [ "$ENV_FAILED" = "1" ] || [ "$code" != "0" ]; then
      # Omit --round entirely when there is no round, rather than passing an empty value.
      local round_args=()
      [ -n "$ENV_ROUND_ID" ] && round_args=(--round "$ENV_ROUND_ID")
      $AGENT digest-failure \
        --stage "$ENV_STAGE" \
        --error "${ENV_ERROR:-exited with code $code}" \
        "${round_args[@]+"${round_args[@]}"}" \
        --persona "$ENV_PERSONA" < /dev/null \
        || printf '{"schema":1,"failure":{"failed":true,"stage":"%s","error":"digest generation failed"},"needsAttention":true}\n' "$ENV_STAGE"
    else
      $AGENT digest --round "$ENV_ROUND_ID" < /dev/null \
        || printf '{"schema":1,"failure":{"failed":true,"stage":"digest","error":"digest generation failed"},"needsAttention":true}\n'
    fi
  fi

  if [ "$ENV_FAILED" = "1" ] && [ "$code" = "0" ]; then exit 1; fi
  exit "$code"
}

# ── the shared steps ───────────────────────────────────────────────────────

# 1. git pull --ff-only. Never merge unattended: a merge commit created by a scheduled
#    job at 3am is a change nobody reviewed, on the machine that holds live sessions.
env_git_pull() {
  step git-pull "git pull --ff-only"
  if [ ! -d .git ]; then say "    not a git checkout — skipping"; return 0; fi
  if [ "${ENV_SKIP_GIT:-0}" = "1" ]; then say "    skipped (ENV_SKIP_GIT)"; ENV_GIT_CHANGED=0; ENV_LOCK_CHANGED=0; return 0; fi
  # Pulling before every run is for a repo that is SHARED between machines — a private
  # data repo (.private-data-repo), or one that opts in with APPLY_AGENT_GIT_PULL=1. A
  # plain clone of the public template updates when its owner runs `git pull`: pulling
  # unattended would bring in new code overnight, and a change to a file the user has
  # edited (src/personas.js) would stop the whole night.
  if [ ! -f .private-data-repo ] && [ "${APPLY_AGENT_GIT_PULL:-0}" != "1" ]; then
    say "    skipped — this checkout updates when you run git pull (APPLY_AGENT_GIT_PULL=1 pulls before every run)"
    ENV_GIT_CHANGED=0; ENV_LOCK_CHANGED=0; return 0
  fi
  # Non-interactive for real: a scheduled run has no terminal to type a password into, and
  # a git that waits for one hangs the whole night instead of failing in a second.
  export GIT_TERMINAL_PROMPT=0
  export GIT_ASKPASS=/bin/true
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10}"
  local before after
  before="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if ! logged "git pull" git pull --ff-only --no-rebase; then
    die "git pull --ff-only failed — the branch has diverged from origin. Resolve it by hand; this script will never merge unattended."
  fi
  after="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if [ "$before" != "$after" ]; then
    say "    updated $before -> $after"
    ENV_GIT_CHANGED=1
  else
    say "    already current"
    ENV_GIT_CHANGED=0
  fi
  # Lock file changed in that pull?
  if [ "$ENV_GIT_CHANGED" = "1" ] && ! git diff --quiet "$before" "$after" -- package-lock.json 2>/dev/null; then
    ENV_LOCK_CHANGED=1
  else
    ENV_LOCK_CHANGED=0
  fi
}

# 2. npm ci ONLY when package-lock.json changed. It deletes and rebuilds node_modules,
#    which is minutes on a 2015 laptop for no reason on an unchanged tree.
env_npm_ci() {
  step npm-ci "dependencies"
  if [ "${ENV_LOCK_CHANGED:-0}" = "1" ]; then
    say "    package-lock.json changed — running npm ci"
    logged "npm ci" npm ci --no-audit --no-fund || die "npm ci failed"
  elif [ ! -d node_modules ]; then
    say "    node_modules absent — running npm ci"
    logged "npm ci" npm ci --no-audit --no-fund || die "npm ci failed"
  else
    say "    lock file unchanged — skipping"
  fi
}

# 3. doctor (blocking subset) + state pull, aborting on divergence.
env_doctor_and_pull() {
  step doctor "machine readiness"
  if ! logged "doctor" $AGENT doctor --persona "$ENV_PERSONA"; then
    die "doctor reported a blocking failure. Run: npm run doctor"
  fi
  say "    ready"

  step state-pull "pull shared state"
  local pulled
  if ! pulled="$(json $AGENT state pull)"; then
    die "state pull failed or the state is newer than this checkout (schema divergence). Run: git pull && npm ci"
  fi
  local skipped
  skipped="$(printf '%s' "$pulled" | json_field skipped)"
  if [ "$skipped" = "true" ]; then say "    no S3 configured — skipping"; else say "    pulled"; fi
}

# 4. round start — the one call that takes the lock and the semaphore and runs the
#    resume/profile/disk/schema preflight. A refusal here is the correct outcome, and its
#    JSON says which guard refused and who holds it.
env_round_start() {
  step round-start "lock, semaphore, preflight"
  local payload started
  payload="$(printf '{"persona":"%s","target":%s,"maxEvaluated":%s,"note":"%s"}' \
    "$ENV_PERSONA" "$ENV_MAX" "${ENV_MAX_EVAL:-45}" "${ENV_NOTE:-run}")"
  # The guards record THIS shell as their holder (APPLY_AGENT_LOCK_PID): `round start`
  # itself exits at once, and its pid would leave the round looking dead until the
  # runner adopts the guards.
  if ! started="$(printf '%s' "$payload" | APPLY_AGENT_LOCK_PID=$$ json_stdin $AGENT round start --stdin)"; then
    # Surface WHICH guard refused, so the caller knows whether to wait, run another
    # persona, or force.
    local guard holder age
    guard="$(printf '%s' "$started" | json_field guard)"
    ENV_ERROR="$(printf '%s' "$started" | json_field error)"
    if [ -n "$guard" ]; then
      holder="$(printf '%s' "$started" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const h=JSON.parse(s).holder||{};process.stdout.write((h.machineId||'?')+' pid '+(h.pid||'?')+(h.roundId?' round '+h.roundId:''))}catch{process.stdout.write('?')}})" 2>/dev/null)"
      age="$(printf '%s' "$started" | json_field heartbeatAgeSeconds)"
      say ""
      say "  REFUSED by: $guard"
      say "  held by:    $holder"
      say "  heartbeat:  ${age}s ago"
      case "$guard" in
        host-semaphore)
          say "  -> This host is already running a browser session. Wait, or run on the other machine." ;;
        profile-lock)
          say "  -> Another run holds this browser profile. Wait for it, run a persona on a different profile (secondary has its own), or if that run is definitely dead:"
          say "     npm run agent -- round unlock --force --persona $ENV_PERSONA" ;;
      esac
      say "  Inspect: npm run agent -- round locks"
    fi
    die "${ENV_ERROR:-round start refused}"
  fi
  ENV_ROUND_ID="$(printf '%s' "$started" | json_field id)"
  [ -n "$ENV_ROUND_ID" ] || die "round start returned no id"
  say "    round: $ENV_ROUND_ID"
  open_log
}

# 5. discovery. Never fatal: a run with a queue already on disk is still a useful run,
#    and a discovery outage must not cost the night.
env_discovery() {
  if [ "${ENV_DISCOVER:-1}" = "0" ]; then
    step discovery "skipped (--no-discover: the caller discovers for this queue)"
    return 0
  fi
  step discovery "refresh the queue"
  if logged "discovery" env PERSONA="$ENV_PERSONA" $AGENT_DISCOVER; then
    say "    done"
  else
    say "    discovery failed — continuing with the queue already on disk"
    printf '{"area":"discovery","reproducible":false,"summary":"discovery failed during a scheduled run","signature":"discovery-failed"}' \
      | logged_stdin "friction" $AGENT friction record --stdin || true
  fi
}

# 6+7. the apply batches, via run-persona.sh — which owns the watchdog, the
# browser-death abort and the fresh-browser-per-batch behaviour. Tailoring runs as a
# batch pass inside it when --tailor is set.
env_apply() {
  step apply "run-persona.sh ($ENV_MAX submissions, batch $ENV_BATCH)"
  local tailor_flag=""
  [ "$ENV_TAILOR" = "1" ] && tailor_flag="--tailor"
  # DRY_RUN must be UNSET for a live run, never set to 0.
  #
  # util/form.js does `if (!process.env.DRY_RUN) return null` — and in JS the string "0"
  # is truthy, so DRY_RUN=0 turns dry-run ON. Passing the flag through as a 0/1 value
  # silently made every --live run a dry run: forms filled, screenshots taken, nothing
  # submitted, and the log cheerfully reporting "DryRun". An env var whose presence is
  # the signal must be absent, not falsy.
  local dry_env=()
  [ "$ENV_DRY_RUN" = "1" ] && dry_env=(DRY_RUN=1)

  # ROUND_ID makes run-persona.sh and run-loop.js adopt the round we already opened
  # rather than opening a second one — a second `round start` is refused by this host's
  # own semaphore, which silently turns the apply phase into a no-op.
  if ! logged "run-persona" \
       env ROUND_ID="$ENV_ROUND_ID" \
           MAX_EVAL="${ENV_MAX_EVAL:-45}" \
           "${dry_env[@]+"${dry_env[@]}"}" \
           bash scripts/run-persona.sh "$ENV_PERSONA" "$ENV_MAX" "$ENV_BATCH" $tailor_flag; then
    # A failed batch loop is not a failed envelope: the round still gets completed and a
    # digest still gets emitted with whatever it managed.
    say "    the apply loop exited non-zero — the digest will show what it reached"
  fi
  say "    apply phase done"
}

# 8. round complete. Releases both guards. Doing it here rather than only in the trap
#    means the success path completes the round normally.
env_round_complete() {
  step round-complete "close the round"
  printf '{"id":"%s","note":"%s"}' "$ENV_ROUND_ID" "${ENV_NOTE:-run} complete" \
    | logged_stdin "round complete" $AGENT round complete --stdin || say "    (already closed)"
}

# 9. commit and push the tracked run output. Privacy audit first, always: it is the gate
#    that keeps ledgers, profiles, resumes and secrets out of a published commit.
env_commit_push() {
  step commit "tracked run output"
  if [ ! -d .git ]; then say "    not a git checkout — skipping"; return 0; fi
  # Only a repo that has opted in to holding run data commits it: the marker file
  # .private-data-repo (in a PRIVATE repo — it also relaxes the privacy audit there).
  # Everywhere else, including any copy of the public template, run history stays in
  # .state/ and nothing is committed or pushed, so no git credentials are needed.
  if [ ! -f .private-data-repo ]; then
    say "    skipped — run history stays in .state/ (add .private-data-repo to a PRIVATE repo to commit it)"
    return 0
  fi
  if ! logged "privacy audit" npm run privacy-audit:strict; then
    say "    PRIVACY AUDIT FAILED — nothing committed. Run: npm run privacy-audit"
    return 0
  fi
  # Only the tracked run output. Never `git add -A`: that is how an untracked profile or
  # a log lands in a commit.
  local files="applications-log.csv seen-jobs.csv session-state.json"
  local present=""
  for f in $files; do [ -f "$f" ] && present="$present $f"; done
  [ -n "$present" ] || { say "    nothing to commit"; return 0; }
  # shellcheck disable=SC2086
  logged "git add" git add $present || true
  if git diff --cached --quiet 2>/dev/null; then say "    no changes"; return 0; fi
  logged "git commit" git commit -m "Run $ENV_ROUND_ID ($ENV_PERSONA): tracked output" || true
  if [ "${ENV_PUSH:-1}" = "1" ]; then
    export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true
    logged "git push" git push || say "    push failed — the commit is local; push by hand"
  fi
  say "    committed"
}

# 10. retention. Rendered PDFs, batch logs and dry-run screenshots; orphan profiles are
# reported but never pruned unattended.
env_gc() {
  step gc "retention"
  logged "gc" $AGENT gc || true
  local n
  n="$(json $AGENT profiles list | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(JSON.parse(s).totals.unknownCount))}catch{process.stdout.write('0')}})" 2>/dev/null)"
  if [ -n "$n" ] && [ "$n" != "0" ]; then
    say "    $n orphan profile dir(s) — review with: npm run agent -- profiles prune"
  fi
  say "    done"
}

# 11. state push.
env_state_push() {
  step state-push "push shared state"
  local pushed skipped
  if ! pushed="$(json $AGENT state push)"; then
    say "    state push FAILED — this machine's state is not shared yet"
    printf '{"area":"state-sync","reproducible":false,"summary":"state push failed","signature":"state-push-failed"}' \
      | logged_stdin "friction" $AGENT friction record --stdin || true
    return 0
  fi
  skipped="$(printf '%s' "$pushed" | json_field skipped)"
  if [ "$skipped" = "true" ]; then say "    no S3 configured — skipping"; else say "    pushed"; fi
}

# 12. the digest is emitted by finish(), so there is exactly one on stdout on every path.
