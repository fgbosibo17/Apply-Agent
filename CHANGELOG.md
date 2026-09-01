# Changelog

All notable changes to **Apply Agent** — the whole project (automation bot, refine
helper, and Chrome extension). This file is the single source of truth; the
[updates page](https://fgbosibo17.github.io/Apply-Agent/) renders it live.

Format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Newest first.

## [Unreleased]
### Added
- **Decision CLI (`node bin/apply-agent.js`)** — a dependency-free layer that owns
  every judgement that shouldn't be made from memory. Reads JSON on stdin, writes
  JSON on stdout, composes with Claude Code, a shell script, or the runner.
- **Append-only ledger** (`.state/applications.ndjson`, `.state/outcomes.ndjson`)
  replacing exact-URL CSV dedup. Canonicalizes the posting first, so one
  requisition collapses across host aliases, `/application` suffixes and tracking
  params — and still matches when the same job arrives from a second source.
  `apply-agent migrate` backfilled the existing history and found 21 jobs that had
  been applied to twice.
- **Gate-before-score fit assessment** — `exclude` / `ask` / `skip` / `review`
  decided from hard facts before any number matters, plus `autoEligible`
  (score ≥ 80, exact seniority, ≥ 70% evidenced must-have coverage) which is
  necessary but never sufficient to submit.
- **Same-company reapply cooldown** (15 days) and requisition-level duplicate
  detection, both overridable only with an explicit confirmation token.
- **Outcome tracking + `ledger review`** — structured outcomes marked `explicit`
  or `inferred`, and response/positive rates by discovery source, application
  channel, score band and persona over applications old enough to have heard back.
- **Attention and friction queues** — a login wall, CAPTCHA or duplicate call is
  parked for the candidate instead of dying as an `Error` row; a reproducible
  tooling failure is recorded without ever blocking an application.
- **Autonomy modes** — `review-each` / `routine-auto`, time-boxed and scopable to
  one persona or batch. A fixed always-stop list (passwords, SSO/MFA, CAPTCHA,
  legal attestations, unverifiable claims) that no grant can lift.
- **Rounds** — one ID threaded through every fresh-browser batch in `run-loop.js`,
  making an overnight run a single addressable unit.
- **OS-keychain profile storage** — macOS Keychain, Windows DPAPI, Linux
  Secret Service, with an owner-only file fallback. Refuses to store
  secret-shaped fields.
- **Local discovery-source catalog** (`data/sources.json`) with filtering by
  kind, region, role family and whether a login is required.
- **Privacy audit** (`npm run privacy-audit`) — fails the build if a ledger,
  browser profile, resume, secret or real candidate PII reaches a tracked file.
  `--ref origin/main` audits what is actually published, not just the local tree.
- **Test suite and CI** — 61 tests (`npm test`) across canonicalization, dedup,
  gates, autonomy, queues, migration and the CLI; GitHub Actions runs them on
  Node 20/22/24 plus a strict privacy audit.
- **MIT LICENSE** and a portable, PII-free `SKILL.md` describing the workflow
  contract independently of any one agent host.

### Changed
- `src/index.js` now runs `ledger check` before every application and
  `ledger add` after every confirmed submission, and parks blockers in the
  attention queue rather than logging them as errors.

### Notes
- Deliberately **not** adopted from the project this work was modelled on:
  telemetry and community job-link sharing. This agent transmits nothing.

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
