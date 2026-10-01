#!/usr/bin/env bash
# Bootstrap a machine for the apply agent.
#
# This is the human-facing one-shot for a NEW machine. It does the things that can
# be done without asking (npm ci), then hands over to `apply-agent doctor`, which
# owns the actual verdict and prints the remedy for every failure.
#
# The division of labour is deliberate: anything that needs sudo, a password, a
# browser login, or a decision is NOT done for you — it is explained. Installing
# Chrome, installing xvfb and logging in to a browser profile all fall in that
# bucket. Remedies live in src/core/preflight.js so they are written once.
#
# Usage:
#   bash scripts/bootstrap.sh              full bootstrap + readiness report
#   bash scripts/bootstrap.sh --check      report only, change nothing
#
# Exit status mirrors doctor: 0 = ready, 1 = something blocking remains.

set -u

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || { echo "cannot cd to repo root"; exit 1; }

MIN_NODE=20

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    ok   %s\n' "$1"; }
warn() { printf '    warn %s\n' "$1"; }
bad()  { printf '    FAIL %s\n' "$1"; }
fix()  { printf '         -> %s\n' "$1"; }

bold "apply-agent bootstrap"
printf '    repo: %s\n' "$ROOT"
printf '    host: %s %s\n' "$(uname -s)" "$(uname -m)"

# ── 1. Node ────────────────────────────────────────────────────────────────
# Checked here in shell rather than left to doctor because doctor is a Node
# program: without a usable Node there is nothing to run and the error would be a
# confusing syntax or engine failure instead of a clear one.
step "Node >= $MIN_NODE"
if ! command -v node >/dev/null 2>&1; then
  bad "node is not installed or not on PATH"
  case "$(uname -s)" in
    Linux)  fix "Install Node 22 LTS: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" ;;
    Darwin) fix "Install Node 22 LTS: brew install node@22   (or use nvm: nvm install 22)" ;;
    *)      fix "Install Node $MIN_NODE or newer from https://nodejs.org" ;;
  esac
  exit 1
fi
NODE_V="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
NODE_MAJOR="${NODE_V%%.*}"
if [ "$NODE_MAJOR" -lt "$MIN_NODE" ] 2>/dev/null; then
  bad "Node $NODE_V is older than the required $MIN_NODE"
  fix "nvm install 22 && nvm use 22   (then re-run this script)"
  exit 1
fi
ok "Node $NODE_V"

# ── 2. Dependencies ────────────────────────────────────────────────────────
step "Dependencies (npm ci)"
if [ ! -f package-lock.json ]; then
  bad "package-lock.json is missing"
  fix "Restore it from git: git checkout package-lock.json"
  exit 1
fi
if [ "$CHECK_ONLY" = "1" ]; then
  if [ -d node_modules ]; then ok "node_modules present (not verifying in --check mode; doctor will)"
  else bad "node_modules absent"; fix "Run: npm ci"; fi
else
  # npm ci is the right verb, not npm install: it installs exactly what the lock
  # file pins and fails loudly if package.json and the lock disagree.
  if npm ci --no-audit --no-fund; then
    ok "npm ci complete"
  else
    bad "npm ci failed"
    fix "Read the npm error above. A corrupt cache is the usual cause: npm cache clean --force && npm ci"
    exit 1
  fi
fi

# ── 3. Platform notes ──────────────────────────────────────────────────────
# Printed before doctor so a new-machine operator knows what the upcoming
# failures will be about. doctor supplies the precise remedies.
if [ "$(uname -s)" = "Linux" ]; then
  step "Headless Linux notes"
  printf '    Every browser-touching command runs under xvfb-run on this box:\n'
  printf '        xvfb-run -a npm run apply\n'
  printf '    There IS a display; it is virtual. Never set headless:true instead —\n'
  printf '    Greenhouse reCAPTCHA Enterprise and Lever hCaptcha score the session,\n'
  printf '    and bundled headless Chromium gets a bot-flagged form.\n'
  printf '\n'
  printf '    Each machine needs its OWN browser login, once, per persona. Profiles\n'
  printf '    are never copied between machines: a Chrome profile carries OS and\n'
  printf '    device fingerprint, and a mismatched one is what CAPTCHA scoring looks\n'
  printf '    for. Log in over x11vnc, then close Chrome.\n'
fi

# ── 4. The verdict ─────────────────────────────────────────────────────────
step "Machine readiness (apply-agent doctor)"
node bin/apply-agent.js doctor --format text
DOCTOR_STATUS=$?

printf '\n'
if [ "$DOCTOR_STATUS" -eq 0 ]; then
  bold "Ready."
  printf '    Next:\n'
  printf '      npm run agent -- doctor            re-check any time (JSON)\n'
  if [ "$(uname -s)" = "Linux" ]; then
    printf '      xvfb-run -a npm run apply          apply, headful under Xvfb\n'
  else
    printf '      npm run apply                      apply\n'
  fi
  printf '      PERSONA=secondary DRY_RUN=1 npm run apply fill forms without submitting\n'
else
  bold "Not ready."
  printf '    Fix the FAIL lines above (each has a -> remedy), then re-run:\n'
  printf '      bash scripts/bootstrap.sh --check\n'
fi

exit "$DOCTOR_STATUS"
