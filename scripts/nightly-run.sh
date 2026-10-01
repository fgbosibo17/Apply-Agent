#!/usr/bin/env bash
# The scheduled / remote-triggered way in. ONE persona per invocation.
#
#   scripts/nightly-run.sh secondary                 dry run (the default — see below)
#   scripts/nightly-run.sh secondary --live          actually submit
#   scripts/nightly-run.sh primary --live --max 40 --tailor
#
# WHICH PERSONA RUNS ON WHICH NIGHT IS NOT THIS REPO'S DECISION. This script takes one
# persona and runs it. The orchestrator decides the rotation, because it is the thing
# that knows what ran last night, which personas have queue left, and what the candidate
# asked for this week. Baking a schedule in here would put that policy in two places and
# guarantee they disagree.
#
# ── REMOTE INVOCATIONS DEFAULT TO --dry-run ────────────────────────────────
# A chat command that submits real applications to real employers is a short path from
# "let me try this" to fifty applications nobody reviewed. So this script fills forms and
# screenshots them unless it is told --live, explicitly, every time. There is no env var
# for it and no config default: the flag is the whole safeguard.
#
# stdout is a single digest JSON document, on every path including failure. Progress goes
# to stderr; verbose output goes to .state/runs/logs/.

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# Cron has a minimal PATH; find node the way an interactive shell would.
. scripts/lib/ensure-node.sh
# shellcheck source=scripts/lib/envelope.sh
. scripts/lib/envelope.sh

# ── defaults ───────────────────────────────────────────────────────────────
# 25 is deliberately conservative for an unattended loop. A night that applies to 25 jobs
# well is worth more than one that applies to 100 badly, and a runaway loop on a shared
# residential IP is how a persona gets rate-limited across every board at once. Raise it
# per invocation with --max when a human is watching the outcome.
ENV_MAX=50
ENV_BATCH=20
ENV_MAX_EVAL=200
ENV_DRY_RUN=1          # live submission requires --live
ENV_TAILOR=0
ENV_PUSH=1
ENV_NOTE="nightly"
AGENT_DISCOVER="node src/discover-api.js"

usage() {
  cat >&2 <<EOF
usage: $(basename "$0") <persona> [--live] [--max <n>] [--max-eval <n>] [--batch <n>] [--tailor] [--no-push] [--no-discover]

  <persona>    primary | adjacent | secondary — exactly one. The orchestrator picks which.
  --live       actually submit. WITHOUT THIS THE RUN IS A DRY RUN.
  --max <n>    submissions to aim for (default ${ENV_MAX}, deliberately conservative)
  --max-eval <n> candidates to EVALUATE per fresh-browser batch (default ${ENV_MAX_EVAL}).
               Distinct from --max: not every evaluated job becomes a submission,
               so reaching --max N needs roughly N/apply-rate evaluations. The run
               ends at --max, or after 4 batches in a row that gain nothing.
  --batch <n>  submissions per fresh browser (default ${ENV_BATCH})
  --tailor     tailor each resume to its posting first (needs a model backend)
  --no-push    commit locally but do not git push
  --no-discover skip the discovery stage (parallel sessions discover once, centrally)

stdout: one digest JSON document, always. stderr: progress. logs: .state/runs/logs/
EOF
}

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --live)     ENV_DRY_RUN=0 ;;
    --dry-run)  ENV_DRY_RUN=1 ;;
    --tailor)   ENV_TAILOR=1 ;;
    --no-push)  ENV_PUSH=0 ;;
    --no-discover) ENV_DISCOVER=0 ;;
    --max)      ENV_MAX="${2:-}"; shift ;;
    --max-eval) ENV_MAX_EVAL="${2:-}"; shift ;;
    --batch)    ENV_BATCH="${2:-}"; shift ;;
    -h|--help)  usage; exit 2 ;;
    -*)         say "unknown flag: $1"; usage; exit 2 ;;
    *)          ARGS+=("$1") ;;
  esac
  shift
done

ENV_PERSONA="${ARGS[0]:-}"
if [ -z "$ENV_PERSONA" ]; then usage; exit 2; fi
if [ "${#ARGS[@]}" -gt 1 ]; then
  say "one persona per invocation (got: ${ARGS[*]}). The orchestrator decides the rotation."
  exit 2
fi
case "$ENV_MAX$ENV_BATCH$ENV_MAX_EVAL" in *[!0-9]*) say "--max, --max-eval and --batch must be whole numbers"; exit 2 ;; esac

# Everything from here emits a digest and releases the lock, whatever happens.
trap finish EXIT

say "=== nightly-run: $ENV_PERSONA ==="
say "    mode:   $([ "$ENV_DRY_RUN" = "1" ] && echo 'DRY RUN (pass --live to submit)' || echo 'LIVE — submitting real applications')"
say "    max:    $ENV_MAX submissions, batch $ENV_BATCH, eval cap $ENV_MAX_EVAL"
say "    tailor: $([ "$ENV_TAILOR" = "1" ] && echo on || echo off)"
say "    utc:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"

env_git_pull            # 1
env_npm_ci              # 2
env_doctor_and_pull     # 3
env_round_start         # 4  lock + semaphore + preflight + schema
env_discovery           # 5
env_apply               # 6 tailoring batch (inside) + 7 apply batches
env_round_complete      # 8
env_commit_push         # 9
env_gc                  # 10
env_state_push          # 11
                        # 12 digest — emitted by finish()
say ""
say "=== nightly-run done: $ENV_PERSONA / $ENV_ROUND_ID ==="
