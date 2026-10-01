#!/usr/bin/env python3
"""
gmail-session-check.py — verify Google/Gmail is still signed in for every browser profile.

Greenhouse and others email a security code before submit; src/util/email-code.js
reads it from Gmail in the same warm profile. A signed-out profile therefore turns
every such application into a silent skip. This checks headlessly via the Cookies
SQLite DB (no browser launch) and sends a Telegram alert when a profile lost its
session (same credentials as scripts/notify-telegram.py; without them it just prints).

  python3 scripts/gmail-session-check.py        # every ./browser-profile-*/ in the repo

Exit codes:
  0 = all profiles OK (or none found)
  1 = one or more profiles lost the Google session
"""
import glob, os, sys, sqlite3, shutil, tempfile, urllib.request, urllib.parse
from datetime import datetime, timezone

REPO  = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDS = os.path.expanduser(os.environ.get("TELEGRAM_CREDENTIALS_FILE", "~/.telegram_notify_credentials"))

# One entry per profile directory (profiles are per ACCOUNT, see src/personas.js).
PROFILES = {
    os.path.basename(d).replace("browser-profile-", ""): os.path.join(d, "Default")
    for d in sorted(glob.glob(os.path.join(REPO, "browser-profile-*")))
    if os.path.isdir(d)
}

# Gmail session cookies — if ANY of these exist the profile is signed in
GMAIL_SESSION_COOKIES = {"SID", "SSID", "HSID", "APISID", "SAPISID", "__Secure-1PSID"}

def load_creds():
    if os.environ.get("TELEGRAM_BOT_TOKEN") and os.environ.get("TELEGRAM_CHAT_ID"):
        return os.environ["TELEGRAM_BOT_TOKEN"], os.environ["TELEGRAM_CHAT_ID"]
    creds = {}
    try:
        with open(CREDS) as f:
            for line in f:
                if "=" in line:
                    k, v = line.strip().split("=", 1)
                    creds[k] = v
    except Exception:
        pass
    return creds.get("TELEGRAM_BOT_TOKEN"), creds.get("TELEGRAM_CHAT_ID")

def send_telegram(msg):
    token, chat_id = load_creds()
    if not token or not chat_id:
        print("WARNING: no Telegram credentials, cannot send alert")
        return
    try:
        data = urllib.parse.urlencode({"chat_id": chat_id, "text": msg}).encode()
        req  = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data=data, method="POST"
        )
        urllib.request.urlopen(req, timeout=10)
        print("Telegram alert sent.")
    except Exception as e:
        print(f"Telegram send failed: {e}")

def check_gmail_session(profile_dir):
    """
    Check if Gmail session cookies exist in the Chrome profile.
    Uses a temp copy of the Cookies DB so Chrome's lock doesn't block us.
    Returns True if signed in, False if not.
    """
    # Newer Chrome keeps the DB under Network/; older builds at the profile root.
    cookies_db = next((p for p in (os.path.join(profile_dir, "Network", "Cookies"),
                                   os.path.join(profile_dir, "Cookies")) if os.path.exists(p)), None)
    if not cookies_db:
        return None  # Profile doesn't exist yet

    # Copy to temp to avoid SQLite lock conflicts with running Chrome
    tmp = tempfile.mktemp(suffix=".db")
    try:
        shutil.copy2(cookies_db, tmp)
        conn = sqlite3.connect(tmp)
        c = conn.cursor()
        c.execute(
            "SELECT name FROM cookies WHERE host_key LIKE '%google%' AND name IN ({})".format(
                ",".join("?" * len(GMAIL_SESSION_COOKIES))
            ),
            list(GMAIL_SESSION_COOKIES)
        )
        rows = c.fetchall()
        conn.close()
        return len(rows) > 0
    except Exception as e:
        print(f"  Cookie check error for {profile_dir}: {e}")
        return None
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass

def main():
    ts  = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    problems = []

    print(f"[{ts}] Gmail session check")
    for label, profile_dir in PROFILES.items():
        result = check_gmail_session(profile_dir)
        if result is True:
            print(f"  ✅ {label}: Gmail signed in")
        elif result is False:
            print(f"  ❌ {label}: NOT signed in to Google")
            problems.append(label)
        else:
            print(f"  ⚠️  {label}: profile not found or unreadable")

    if problems:
        # A headless server logs in over VNC; a machine with a screen opens Chrome directly.
        headless = sys.platform.startswith("linux") and not os.environ.get("DISPLAY")
        login = "bash scripts/login-profile.sh" if headless else "node setup-browser-login.js"
        msg = (
            "🚨 GOOGLE NOT SIGNED IN — the agent cannot read emailed verification codes for:\n\n"
            + "\n".join(f"• {p}" for p in problems)
            + "\n\nAction: sign in to Google in the affected profile(s) on this machine:\n"
            + "\n".join(f"  {login} {p}   ({os.path.join(REPO, 'browser-profile-' + p)})" for p in problems)
            + "\n"
            + "\nApplications requiring a security code will be skipped until this is fixed."
        )
        print(msg)
        send_telegram(msg)
        sys.exit(1)

    sys.exit(0)

if __name__ == "__main__":
    main()
