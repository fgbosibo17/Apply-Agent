#!/usr/bin/env python3
"""
notify-telegram.py <summary_json_path>

Sends one Telegram message summarizing a nightly-orchestrator.sh (or
persona-push.sh) run. Optional: with no credentials configured it exits quietly.

Credentials, first match wins:
  1. TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment
  2. the file named by TELEGRAM_CREDENTIALS_FILE (default
     ~/.telegram_notify_credentials): KEY=VALUE lines, chmod 600, kept OUTSIDE
     the repo so it can never be committed.

Designed to be defensive: if a digest file is missing or malformed, that
persona is reported as "no digest (check log)" rather than crashing the
whole notification -- a broken digest must never mean nobody hears anything.

Counts submissions since the run STARTED (ranAt), not since UTC midnight -
runs cross midnight. Times are shown in NOTIFY_TZ (an IANA zone such as
America/New_York; default UTC) and durations as hours/minutes.
"""
import sys
import os
import json
import urllib.request
import urllib.parse
from datetime import datetime, timezone

CREDS_PATH = os.path.expanduser(os.environ.get("TELEGRAM_CREDENTIALS_FILE", "~/.telegram_notify_credentials"))
NOTIFY_TZ = os.environ.get("NOTIFY_TZ", "UTC")
TARGET = 50


def load_creds():
    """(token, chat_id), or (None, None) when Telegram is not configured."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if token and chat_id:
        return token, chat_id
    creds = {}
    try:
        with open(CREDS_PATH, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                creds[k] = v
    except FileNotFoundError:
        return None, None
    return creds.get("TELEGRAM_BOT_TOKEN"), creds.get("TELEGRAM_CHAT_ID")


def _repo():
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _ledger_count(persona, since_iso):
    """Count submitted applications for persona since the run started."""
    ndjson = os.path.join(_repo(), ".state", "applications.ndjson")
    count = 0
    try:
        with open(ndjson, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    a = json.loads(line)
                except Exception:
                    continue
                if (a.get("persona") == persona and a.get("status") == "submitted"
                        and a.get("ts", "")[:19] >= since_iso):
                    count += 1
    except Exception:
        return 0
    return count


def _dur(sec):
    try:
        sec = int(sec)
    except Exception:
        return ""
    h, m = divmod(sec // 60, 60)
    return f"{h}h {m}m" if h else f"{m}m"


def _local(dt):
    try:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo(NOTIFY_TZ)).strftime("%a %b %-d, %-I:%M %p %Z")
    except Exception:
        return dt.strftime("%Y-%m-%d %H:%M UTC")


def summarize_persona(result, since_iso):
    persona = result.get("persona", "?")
    exit_code = result.get("exitCode")
    duration = result.get("durationSec")
    rounds = result.get("rounds")
    digest_file = result.get("digestFile")

    evaluated = errored = None
    attention_reason = None

    if rounds == 0:
        attention_reason = "never got a turn this run"
    elif digest_file and os.path.exists(digest_file):
        try:
            with open(digest_file, "r", encoding="utf-8") as f:
                digest = json.load(f)
            counts = digest.get("counts") or digest.get("progress") or {}
            evaluated = counts.get("evaluated")
            errored = counts.get("errored")
            failure = digest.get("failure") or {}
            if digest.get("needsAttention") or failure.get("failed"):
                attention_reason = failure.get("error") or failure.get("stage") or "needs attention"
        except Exception as e:
            attention_reason = f"digest unreadable: {e}"
    else:
        attention_reason = "no digest file (check the round log)"

    target = result.get("target") or TARGET
    applied = _ledger_count(persona, since_iso)
    if applied == 0 and not attention_reason:
        attention_reason = "0 submissions"
    ok = exit_code in (0, None) and not attention_reason
    icon = "✅" if applied >= target else ("•" if ok else "⚠️")

    line = f"{icon} {persona}: {applied}/{target}"
    extras = []
    if evaluated is not None:
        extras.append(f"last round {evaluated} evaluated")
    if errored:
        extras.append(f"{errored} errors")
    if rounds:
        extras.append(f"{rounds} round" + ("" if rounds == 1 else "s"))
    if duration:
        extras.append(_dur(duration))
    if extras:
        line += " (" + ", ".join(extras) + ")"
    if exit_code not in (0, None):
        line += f" [exit {exit_code}]"
    if attention_reason:
        line += f"\n    ↳ {str(attention_reason)[:160]}"
    return line, ok, applied


def main():
    if len(sys.argv) != 2:
        print("usage: notify-telegram.py <summary_json_path>", file=sys.stderr)
        sys.exit(2)

    summary_path = sys.argv[1]
    try:
        with open(summary_path, "r", encoding="utf-8") as f:
            summary = json.load(f)
    except Exception as e:
        # Even a completely unreadable summary must still notify -- silence
        # is the one outcome this script exists to prevent.
        send(f"⚠️ Job Apply run ended without a readable summary ({os.path.basename(summary_path)}): {e}")
        return

    ran_at = summary.get("ranAt", "")
    try:
        start = datetime.strptime(ran_at, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        since_iso = start.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        start, since_iso = None, datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00")
    mode = summary.get("mode", "?")
    results = summary.get("results", [])

    lines, all_ok, total = [], True, 0
    for r in results:
        line, ok, applied = summarize_persona(r, since_iso)
        lines.append(line)
        all_ok = all_ok and ok
        total += applied

    head_icon = "✅" if all_ok else "⚠️"
    header = f"{head_icon} Job Apply run finished"
    if start:
        header += f" — started {_local(start)}"
    if "dry" in mode:
        header += " (DRY RUN)"
    text = header + "\n\n" + "\n".join(lines) + f"\n\nTotal this run: {total} applied"
    send(text)


def send(text):
    token, chat_id = load_creds()
    if not token or not chat_id:
        print("notify-telegram: not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) - skipping", file=sys.stderr)
        return
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except Exception as e:
        # Last resort: at least leave a trace on disk if Telegram itself is
        # unreachable, since stdout here goes nowhere unattended.
        print(f"notify-telegram: send failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
