# Changelog

All notable changes to **Apply Agent** — the whole project (automation bot, refine
helper, and Chrome extension). This file is the single source of truth; the
[updates page](https://fgbosibo17.github.io/Apply-Agent/) renders it live.

Format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Newest first.

## [Unreleased]
_Nothing yet — add changes here as you ship them._

## [0.1.0] - 2026-07-23
_First public preview. Still rough — expect changes._
### Added
- **Chrome extension** for applying by hand in your own browser:
  - One-click autofill on company ATS pages (Greenhouse, Lever, Ashby, Workable, and more).
  - **AI answer refine** — rewrite any free-text answer in plain English ("make this
    shorter", "lean into Playwright") via a local Claude helper that uses your
    Claude subscription (no API key).
  - **Shared ledger** with the automation bot (`seen-jobs.csv` / `applications-log.csv`)
    so the two tools never double-apply to the same job.
  - Per-job clear buttons on the discovery list, and a "log after submit" flow that
    survives the page navigating away.
- **Refine helper** (`src/refine-helper.js`) — a tiny local server bridging the
  extension to the `claude` CLI and the shared application ledger.

### Notes
- The extension is installed via "Load unpacked" for now (not yet on the Chrome Web
  Store). To update: pull the latest and hit **Reload** on the extension card.
- All personal data stays local — committed files carry only placeholder templates.

---

_Add a new dated section here each time you ship a change to any part of the app._
