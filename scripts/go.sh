#!/usr/bin/env bash
# The laptop way in: same envelope, human-chosen moment.
#
#   npm run go -- primary             apply as primary
#   npm run go -- secondary --max 15
#   npm run go -- primary --dry-run   fill and screenshot, submit nothing
#   npm run go -- adjacent --tailor
#
# Identical to scripts/nightly-run.sh in every step — same lock, same state sync, same
# digest — and different in exactly two ways, both because a human is present:
#
#   1. IT SUBMITS BY DEFAULT. The scheduled path defaults to a dry run because nobody is
#      watching it; here somebody typed the command just now and meant it. --dry-run is
#      still one flag away.
#   2. A LOCK REFUSAL IS EXPLAINED, not just reported. When the other machine holds the
#      profile, the useful question is "wait, switch persona, or force?" — so the holder,
#      its machine and its heartbeat age are printed, with the three options.
#
# stdout is still one digest JSON document. Read the progress on stderr.

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# shellcheck source=scripts/lib/envelope.sh
. scripts/lib/envelope.sh

ENV_MAX=25
ENV_BATCH=20
ENV_MAX_EVAL=45
ENV_DRY_RUN=0          # a human asked for this one; --dry-run to fill without submitting
ENV_TAILOR=0
ENV_PUSH=1
ENV_NOTE="go"
AGENT_DISCOVER="node src/discover-api.js"

usage() {
  cat >&2 <<EOF
usage: npm run go -- <persona> [--dry-run] [--max <n>] [--batch <n>] [--tailor] [--no-push]

  <persona>    primary | adjacent | secondary
  --dry-run    fill forms and screenshot them; submit nothing
  --max <n>    submissions to aim for (default ${ENV_MAX})
  --batch <n>  submissions per fresh browser (default ${ENV_BATCH})
  --tailor     tailor each resume to its posting first
  --no-push    commit locally but do not git push

This SUBMITS by default — it is the interactive path. The scheduled path
(scripts/nightly-run.sh) is the one that defaults to a dry run.
EOF
}

ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  ENV_DRY_RUN=1 ;;
    --live)     ENV_DRY_RUN=0 ;;
    --tailor)   ENV_TAILOR=1 ;;
    --no-push)  ENV_PUSH=0 ;;
    --max)      ENV_MAX="${2:-}"; shift ;;
    --batch)    ENV_BATCH="${2:-}"; shift ;;
    -h|--help)  usage; exit 2 ;;
    -*)         say "unknown flag: $1"; usage; exit 2 ;;
    *)          ARGS+=("$1") ;;
  esac
  shift
done

ENV_PERSONA="${ARGS[0]:-}"
if [ -z "$ENV_PERSONA" ]; then
  say "which persona? primary | adjacent | secondary"
  say "(there is no default: each is a different identity, and applying as the wrong one"
  say " puts the wrong name and resume in front of an employer.)"
  usage
  exit 2
fi
if [ "${#ARGS[@]}" -gt 1 ]; then say "one persona at a time (got: ${ARGS[*]})"; exit 2; fi
case "$ENV_MAX$ENV_BATCH" in *[!0-9]*) say "--max and --batch must be whole numbers"; exit 2 ;; esac

trap finish EXIT

say "=== go: $ENV_PERSONA ==="
say "    mode:   $([ "$ENV_DRY_RUN" = "1" ] && echo 'DRY RUN' || echo 'LIVE — submitting real applications')"
say "    max:    $ENV_MAX submissions, batch $ENV_BATCH"
say "    tailor: $([ "$ENV_TAILOR" = "1" ] && echo on || echo off)"
say "    local:  $(date +%Y-%m-%dT%H:%M:%S%z)   utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

env_git_pull
env_npm_ci
env_doctor_and_pull
env_round_start
env_discovery
env_apply
env_round_complete
env_commit_push
env_gc
env_state_push

say ""
say "=== go done: $ENV_PERSONA / $ENV_ROUND_ID ==="
say "    digest on stdout. Telegram-sized summary:"
say "      npm run agent -- digest --round $ENV_ROUND_ID --format telegram"
