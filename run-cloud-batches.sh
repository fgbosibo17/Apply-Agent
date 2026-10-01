#!/usr/bin/env bash
# Cloud batch runner — kept as an entry point, now a wrapper around the portable one.
#
# The original was Windows-only and carried three hardcoded assumptions that have
# since rotted:
#
#   * a SCRATCH path under the user's Windows Temp directory for batch logs. Those
#     logs name the persona and email and list every job URL evaluated; they now go
#     to the owner-only 0700 state dir via src/core/paths.js runLogs().
#   * kill_cloudfs_chrome() shelled out to PowerShell, and targeted
#     `browser-profile-cloudfs` — a profile name that no longer exists. Personas own
#     exactly one profile each, derived in src/personas.js, and run-loop.js kills the
#     holder of that directory portably.
#   * counting applied rows out of applications-log.csv with a `>= '2026-06-27'`
#     date window, which measures a lifetime total against a stale boundary instead
#     of this run's progress. Progress now comes from the ledger, scoped to the
#     round.
#
# It also ran `node src/index.js` per batch by hand. src/run-loop.js does that with
# a watchdog that force-kills a hung batch's whole process tree, a browser-death
# abort, and in-place profile repair when a batch gains nothing.
#
# Prefer calling it directly:
#   scripts/run-persona.sh primary 500 25
set -u
cd "$(dirname "$0")" || exit 1
exec bash scripts/run-persona.sh primary "${TARGET_TOTAL:-500}" "${BATCH:-25}"
