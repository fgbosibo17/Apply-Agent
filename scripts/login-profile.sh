#!/usr/bin/env bash
# scripts/login-profile.sh <persona>
#
# Log a persona's browser profile in ONCE on a headless Linux server, over VNC.
#
#   1. on the server:   bash scripts/login-profile.sh primary
#   2. on your laptop:  ssh -N -L 5900:localhost:5900 you@server       (leave it open)
#   3. open a VNC viewer at localhost:5900
#        macOS: Finder → Go → Connect to Server → vnc://localhost:5900
#        Windows/Linux: any VNC viewer (TigerVNC, RealVNC) → localhost:5900
#   4. sign in to Google and LinkedIn in that Chrome window, then close Chrome.
#
# WHY A SCRIPT. The login needs ONE virtual screen that Chrome draws on and the VNC
# server shows. `xvfb-run -a` picks its own display number and `x11vnc -display :0`
# looks at a different one, so doing it by hand usually ends in a black VNC window.
# This starts Xvfb on a fixed display, points both at it, and cleans up on exit.
#
# The profile directory comes from src/personas.js (profileKey), so personas that
# share an account share the login. Never copy a profile from another machine — its
# device fingerprint is exactly what CAPTCHA scoring flags. VNC listens on localhost
# only; reach it through the ssh tunnel above, never by opening the port.
#
# Env: LOGIN_DISPLAY (default :77), VNC_PORT (default 5900), APPLY_AGENT_CHROME_PATH.
set -u
PERSONA="${1:-}"
if [ -z "$PERSONA" ] || [ "$PERSONA" = "-h" ] || [ "$PERSONA" = "--help" ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
# shellcheck source=scripts/lib/ensure-node.sh
. scripts/lib/ensure-node.sh
command -v node >/dev/null 2>&1 || { echo "Node.js is needed to resolve the persona's profile — install Node 20+ first (see README, Part 2)." >&2; exit 1; }

DISP="${LOGIN_DISPLAY:-:77}"
PORT="${VNC_PORT:-5900}"

DIR="$(PERSONA_KEY="$PERSONA" node -e "
  const p = require('./src/personas');
  const d = p.profileDirFor(process.env.PERSONA_KEY);
  if (!d) { console.error('unknown persona \"' + process.env.PERSONA_KEY + '\" — expected one of: ' + Object.keys(p.personas).join(', ')); process.exit(2); }
  console.log(d);
")" || exit 2

CHROME="${APPLY_AGENT_CHROME_PATH:-}"
if [ -z "$CHROME" ]; then
  for c in google-chrome google-chrome-stable /opt/google/chrome/chrome; do
    if command -v "$c" >/dev/null 2>&1; then CHROME="$(command -v "$c")"; break; fi
  done
fi

missing=""
command -v Xvfb   >/dev/null 2>&1 || missing="$missing xvfb"
command -v x11vnc >/dev/null 2>&1 || missing="$missing x11vnc"
if [ -n "$missing" ]; then
  echo "missing:$missing   →   sudo apt-get install -y$missing" >&2
  exit 1
fi
if [ -z "$CHROME" ]; then
  echo "Google Chrome not found → wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt-get install -y ./google-chrome-stable_current_amd64.deb" >&2
  exit 1
fi

# A run already using this profile owns it: a second Chrome on the same directory
# would hand the window to that run's browser instead of opening one here.
if pgrep -f -- "--user-data-dir=$DIR( |$)" >/dev/null 2>&1; then
  echo "A browser is already using $DIR (a run in progress?). Stop it first:" >&2
  echo "  npm run agent -- round locks      then   npm run agent -- round stop --round <id>" >&2
  exit 1
fi

DISP_NUM="${DISP#:}"
if [ -e "/tmp/.X11-unix/X$DISP_NUM" ] || [ -e "/tmp/.X$DISP_NUM-lock" ]; then
  echo "display $DISP is already in use — pick another: LOGIN_DISPLAY=:78 bash $0 $PERSONA" >&2
  exit 1
fi

XVFB_PID=""; VNC_PID=""
cleanup() {
  [ -n "$VNC_PID" ] && kill "$VNC_PID" 2>/dev/null
  [ -n "$XVFB_PID" ] && kill "$XVFB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

Xvfb "$DISP" -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
XVFB_PID=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "/tmp/.X11-unix/X$DISP_NUM" ] && break
  sleep 0.5
done
if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "Xvfb failed to start on $DISP" >&2
  exit 1
fi

x11vnc -display "$DISP" -localhost -rfbport "$PORT" -nopw -forever -shared -quiet -bg -o /dev/null >/dev/null 2>&1
VNC_PID="$(pgrep -f "x11vnc -display $DISP " | head -1)"
if [ -z "$VNC_PID" ]; then
  echo "x11vnc failed to start on port $PORT (in use? try VNC_PORT=5901)" >&2
  exit 1
fi

mkdir -p "$DIR"
SANDBOX=()
if [ "$(id -u)" = "0" ]; then
  # Chrome refuses to start as root without this. Prefer a normal user for the agent.
  SANDBOX=(--no-sandbox)
  echo "note: running as root — Chrome needs --no-sandbox; a non-root user is recommended" >&2
fi

HOST="$(hostname 2>/dev/null || echo server)"
cat <<EOF

  Profile : $PERSONA  →  $DIR
  Screen  : $DISP     VNC on localhost:$PORT

  On your laptop:
    ssh -N -L $PORT:localhost:$PORT <you>@$HOST
  then open a VNC viewer at localhost:$PORT
    (macOS: Finder → Go → Connect to Server → vnc://localhost:$PORT)

  Sign in to Google first, then LinkedIn and any job boards.
  Close Chrome when you are done — the login is saved and this script exits.

EOF

# --password-store=basic and --use-mock-keychain are what Playwright passes when the
# runner launches this profile. Chrome encrypts cookies with a key chosen by those
# flags, so logging in WITHOUT them saves a session the runner cannot read.
CHROME_LOG="$(mktemp "${TMPDIR:-/tmp}/login-profile-chrome.XXXXXX")"
STARTED="$(date +%s)"
# Run from /tmp so a crashing Chrome can never drop a core file into the repo.
( cd "${TMPDIR:-/tmp}" && DISPLAY="$DISP" "$CHROME" ${SANDBOX[@]+"${SANDBOX[@]}"} --user-data-dir="$DIR" \
  --no-first-run --no-default-browser-check --password-store=basic --use-mock-keychain \
  https://accounts.google.com/ https://www.linkedin.com/login ) >"$CHROME_LOG" 2>&1
CHROME_STATUS=$?
RAN=$(( $(date +%s) - STARTED ))

# A normal close exits 0. A crash (seccomp/sandbox in a container, missing libraries)
# exits non-zero within seconds — and must not be reported as a saved login.
if [ "$CHROME_STATUS" -ne 0 ] && [ "$RAN" -lt 20 ]; then
  echo "Chrome exited with status $CHROME_STATUS after ${RAN}s — it crashed, nothing was logged in." >&2
  echo "Last lines of its output:" >&2
  tail -n 15 "$CHROME_LOG" | sed 's/^/  /' >&2
  echo "Inside Docker/LXC, Chrome's sandbox needs: --security-opt seccomp=unconfined --cap-add SYS_ADMIN (or a full VM)." >&2
  rm -f "$CHROME_LOG"
  exit 1
fi
rm -f "$CHROME_LOG"
if [ -f "$DIR/Default/Cookies" ] || [ -f "$DIR/Default/Network/Cookies" ]; then
  echo "Chrome closed — profile saved at $DIR."
  echo "Check the Google login with: python3 scripts/gmail-session-check.py   (and: npm run doctor)"
else
  echo "Chrome closed, but no cookies were saved in $DIR — did you sign in? Run this again if not." >&2
  exit 1
fi
