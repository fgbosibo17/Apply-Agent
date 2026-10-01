#!/usr/bin/env bash
# Cloud apply loop — kept as an entry point, now a wrapper around the portable one.
#
# This script used to be Windows-Git-Bash-only and is now three lines of delegation.
# What was wrong with it:
#
#   * wait_chrome_free() used `tasklist //FI 'IMAGENAME eq chrome.exe' //NH`, which
#     exists only on Windows, and waited on ANY chrome.exe — with a browser open on
#     the machine it never returned.
#   * progress came from `grep -c '2026-06'` over applications-log.csv: a hardcoded
#     month, long stale. Every application from June 2026 still matches, so the
#     count now starts above any sane target and the loop exits having done nothing.
#     It also read the legacy CSV rather than the ledger, and measured a lifetime
#     total rather than this run's progress.
#   * it called `node src/index.js` directly, so it had no watchdog for a hung
#     batch and no fresh browser per batch.
#
# scripts/run-persona.sh fixes all three and works on macOS, Linux (headless
# included, via xvfb-run) and Windows Git Bash. Per-cycle discovery is now handled
# inside src/run-loop.js, which refreshes sources once through src/prerun.js before
# the first browser starts.
#
# Prefer calling it directly:
#   scripts/run-persona.sh primary 50 25
set -u
cd "$(dirname "$0")" || exit 1
exec bash scripts/run-persona.sh primary "${TARGET:-50}" "${BATCH:-25}"
