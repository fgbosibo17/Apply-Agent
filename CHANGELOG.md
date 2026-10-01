# Changelog

All notable changes to **Apply Agent** — the whole project (automation bot, refine
helper, and Chrome extension). This file is the single source of truth; the
[updates page](https://fgbosibo17.github.io/Apply-Agent/) renders it live.

Format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Newest first.

## [Unreleased]
### Added
- **LICENSE** (MIT), matching the `license` field package.json already declared.

## [0.1.5] - 2026-10-01
_Run it all night on a Linux server: a scheduled orchestrator, parallel sessions,
cross-machine locks, six more ATSs, opt-in resume tailoring, and a decision layer
that settles duplicates, fit and autonomy. The README is now two guides — apply for
yourself, or run nightly on a server._

### Fixed — found by an end-to-end server test
- **Run guards were never taken.** The run envelope fed every `--stdin` command an
  empty document (`< /dev/null` replaced the pipe), so rounds started with no persona:
  no profile lock, no host semaphore, and preflight checked every persona instead of
  the one running. Fixed, with a test that every piped call keeps its payload.
- **Host semaphore slots.** With locks working, parallel sessions need more than one
  browser per host: `PARALLEL_SESSIONS` now sets the slot count automatically, or set
  `APPLY_AGENT_HOST_BROWSER_SLOTS`. One slot remains the default.
- **The answer reviewer could replace an essay with the phone number** — `/cell/`
  matched "ex**cell**ence". Identity labels now match whole words and never textareas
  or sentence-length prompts.
- **Placeholder personas.** Unused example personas no longer block rounds (they warn),
  running a placeholder persona is refused, and deleting examples no longer crashes
  routing.
- **Dry runs** stop at `--max`, count as `dryRun` (not errors) in digests, keep one
  screenshot per form, and no longer mark the job seen — the real run can still apply.
- **Citizenship-only postings** are skipped only when the persona is not a US citizen
  (clearance-required postings are still skipped for everyone).
- `scripts/login-profile.sh` reports a Chrome crash instead of "saved"; core dumps are
  ignored. The Gmail check points a server at `login-profile.sh`.
- `scripts/stop-sessions.sh` stops and pauses parallel sessions cleanly; sessions no
  longer re-run discovery (`nightly-run.sh --no-discover`); `persona-push.sh` is a dry
  run unless `--live` and rejects unknown flags; the orchestrator's cycle cap is
  `MAX_CYCLES` (an exported `MAX_ROUNDS` also capped the runner's batches) and its
  stdout is pure JSON.
- Runs commit run history only in a private repo marked `.private-data-repo`; elsewhere
  it stays in `.state/` and no git credentials are needed.

### Added — overnight server runs, more ATSs, resume tailoring
- **Six more ATS handlers** — Workday, iCIMS, Jobvite, BambooHR, Breezy and
  Rippling, plus Workday discovery (`src/discover-workday.js`) over the tenants
  you list in `data/workday-boards.json`. Workday, iCIMS and Jobvite sign in or
  register with `data/ats-accounts.json` (gitignored; copy the `.example`).
- **One run envelope** — `npm run go -- <persona>` (interactive, submits) and
  `scripts/nightly-run.sh <persona>` (scheduled, dry unless `--live`) do git
  pull, deps, doctor, state pull, a round with lock + semaphore + preflight,
  discovery, optional tailoring, the apply batches, and a digest JSON on stdout
  on every path, failures included.
- **Running all night on a server** — `scripts/nightly-orchestrator.sh`
  round-robins every persona toward a per-persona target, stops before the next
  night, and never overlaps itself; `scripts/persona-push.sh` gets one persona to
  a number now; `scripts/bootstrap.sh` + `npm run doctor` set up and verify a new
  box (real Chrome, xvfb, disk, profiles, resumes, S3); `scripts/with-display.sh`
  runs headful Chrome on a virtual display.
- **Parallel sessions** — `PARALLEL_SESSIONS` in `src/personas.js` runs one
  persona as several browsers with their own profiles and queues and one shared
  ledger; `scripts/parallel-session.sh`, `scripts/watchdog-sessions.sh` and
  `scripts/redistribute-queues.py` keep them fed and alive.
- **Multi-machine safety** — cross-machine profile locks and a per-host browser
  semaphore (`src/core/locks.js`), state sync over S3 that refuses to carry a
  browser profile, a schema gate, disk-space preflight, and graceful
  `round stop`.
- **Optional alerts** — `scripts/notify-telegram.py` (end-of-run summary) and
  `scripts/gmail-session-check.py` (a profile lost its Google session, so email
  security codes would fail).
- **Resume tailoring** (`--tailor`, opt-in) — rewords and reorders only what the
  base resume already says, verified before upload; markdown sources kept,
  rendered PDFs garbage-collected (`npm run agent -- gc`).
- **Pre-submit answer review** and **posting freshness** checks, Greenhouse
  email-code verification, cover letters only when a form requires one,
  browser hygiene for bot-scoring cookies, and `src/trace-report.js`.
- **Company rules** — never re-apply to the same role at a company, one persona
  per company (`src/core/company-cap.js`), a salaried-only filter, priority
  companies (`data/priority-companies.json`) and a per-ATS pause
  (`data/ats-hold.json`).

### Changed
- **One browser profile per ACCOUNT, not per persona**: `profileKey` in
  `src/personas.js` (the template's `adjacent` shares `primary`'s profile).
- **EEO answers come only from the persona** (`src/util/eeo.js`). Gender, race,
  pronouns, Hispanic/Latino, veteran and disability were partly hard-coded; an
  unset field now picks the form's decline option instead of a guess.
- The personal company blocklist moved out of the code into
  `data/personal-exclude.json` (gitignored). State, ZIP and salary fallbacks no
  longer default to fixed values.
- Default posting recency window is 60 days; the default company reapply
  cooldown is "never" (9999 days, `APPLY_AGENT_COMPANY_REAPPLY_COOLDOWN_DAYS`).

### Added — decision layer, ledger and privacy audit
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
- **Test suite and CI** — `npm test` across canonicalization, dedup, gates,
  autonomy, queues, migration, locks, preflight, tailoring, EEO and the CLI (390
  tests in this release); GitHub Actions runs them on Node 20/22/24 plus a strict
  privacy audit.
- A portable, PII-free `SKILL.md` describing the workflow contract independently
  of any one agent host.

### Changed — runner
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
