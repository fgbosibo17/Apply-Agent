#!/usr/bin/env bash
# Run a command with somewhere for Chrome to draw.
#
#   scripts/with-display.sh node src/run-loop.js
#   scripts/with-display.sh npm run apply
#
# Engages `xvfb-run -a` when $DISPLAY is unset AND xvfb-run exists. A no-op
# everywhere else: on macOS, on Windows, and on a Linux box with a real session.
#
# WHY THIS EXISTS RATHER THAN headless:true
# src/index.js launches real Chrome with `channel: 'chrome', headless: false`
# against a persistent per-persona profile, deliberately. Greenhouse's invisible
# reCAPTCHA Enterprise and Lever's passive hCaptcha score the browser session: warm
# real Chrome passes silently where bundled headless Chromium gets a bot-flagged
# form. So a headless SERVER still runs a headful browser — it just needs a virtual
# display. There is a display; it is not real.
#
# Setting headless:true instead would trade a visible failure for silent
# CAPTCHA-scored rejection, which is far worse: applications appear to submit and
# quietly never arrive.
#
# `-a` picks a free display number, so concurrent runs cannot collide on :99.
set -u

if [ "$#" -eq 0 ]; then
  echo "usage: $(basename "$0") <command> [args...]" >&2
  exit 2
fi

if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  # -e /dev/stderr surfaces Xvfb's own errors instead of swallowing them; without
  # it, a failure to start the virtual display looks like the command failing.
  exec xvfb-run -a -e /dev/stderr "$@"
fi

exec "$@"
