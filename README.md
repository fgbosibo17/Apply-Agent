# Autonomous Job-Application Agent

An AI-driven agent that **finds remote/hybrid jobs and applies to them for you** — end to end, on the company's real ATS (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, CareerPuck, Workday, iCIMS, Jobvite, BambooHR, Breezy, Rippling). It discovers fresh openings, scores fit, fills every form field intelligently from your profile, writes tailored screening answers, **proof-reads before submitting**, and logs everything so it never applies to the same job twice.

It's built to be driven by **[Claude Code](https://claude.com/claude-code)** (talk to it: "setup", then "go"), but the core is plain Node + Playwright and runs on its own too — including unattended, all night, on a Linux server.

> ⚠️ **Use this on your own behalf, with your own data, for jobs you'd genuinely take.** It submits real applications to real employers. Don't mass-spam. Keep your answers truthful to your resume.

---

## Pick your setup

| | **[Part 1 — Apply for yourself](#part-1--applying-for-yourself)** | **[Part 2 — Nightly server](#part-2--running-nightly-on-a-server)** |
|---|---|---|
| **Who it's for** | You, on your own laptop, applying when you choose | Anyone who wants applications going out every night without a laptop open |
| **Where it runs** | macOS, Windows or Linux with a screen | A Linux server (cloud VM or a spare box), no screen needed |
| **How you drive it** | Talk to Claude Code, or `npm run go -- <persona>` | `cron` runs `scripts/nightly-orchestrator.sh` |
| **You watch it?** | Yes — dry-run first, review, then go live | No — dry by default until you add `--live`; optional Telegram summary |
| **Setup time** | ~15 minutes | ~1 hour (one-time) |

Both parts start from the same profile: your resume in `Resume/` and your answers in `src/personas.js`. Set up Part 1 first even if you're heading for Part 2 — it's the quickest way to check your answers before anything runs unattended.

---

# Part 1 — Applying for yourself

Run it on your own computer, see every application, and stay in control.

### 1. Install

```bash
git clone https://github.com/fgbosibo17/Apply-Agent.git job-agent
cd job-agent
npm install
npx playwright install chrome    # uses your real Chrome channel
```

You need **Node 20+** and **Google Chrome** (real Chrome, not Chromium — see [How it gets past CAPTCHAs](#how-it-gets-past-captchas)). Check your machine any time with `npm run doctor`.

### 2. Set up your profile

**Easiest — let Claude Code do it:**

1. Drop your resume PDF into `Resume/`.
2. Open this folder in Claude Code (`claude`).
3. Say **`setup`** — it reads your resume, fills your profile, asks only what it can't find (work authorization, salary, EEO answers), and walks you through browser logins.

**Or by hand:**

1. Drop your resume(s) into `Resume/`.
2. Edit **`src/personas.js`** — your name, email, phone, location, work authorization, EEO answers, salary, target job titles (`matchKeywords`/`targetRoles`), and `resumePath`. It's all `<FILL_ME_IN>` placeholders to start. Delete the example personas you don't need — most people need one.
3. Customize **`src/answer-bank.js`** — the example skills/answers are for tech roles; edit them for *your* field so screening answers ring true.

> **Personas:** a persona is one resume + one set of target titles. The template ships three examples — `primary`, `adjacent` (same person, different resume) and `secondary` (a second identity). Two personas on the same identity share one browser profile automatically (`profileKey`).

> **Two run paths, one set of facts.** Driving it **with Claude Code** fills forms from the `📝 APPLICATION ANSWERS` block in `CLAUDE.md`. Running from the **terminal** reads `src/personas.js`. The `setup` wizard fills **both**; if you edit by hand, keep the two in sync.

### 3. Log in to job boards once (optional but recommended)

```bash
node setup-browser-login.js primary
```

Opens a normal Chrome window on that persona's own profile folder (Windows, macOS or Linux desktop — it finds Chrome itself; set `CHROME_PATH` if it can't). Sign in to Google and the job boards, then close it — the session is saved (and gitignored), so you only do this once. On Windows, close your own Chrome first.

### 4. Apply

**With Claude Code (recommended).** Use the ready-made prompts in **[`prompts/`](prompts/)** — fill in the blanks and paste:

- **[`prompts/01-first-run.md`](prompts/01-first-run.md)** — first time: reads your resume, builds your profile, asks what it can't find, then applies (review-before-submit).
- **[`prompts/02-subsequent-runs.md`](prompts/02-subsequent-runs.md)** — every run after: skips setup and applies to more jobs.

Or just talk to it. The most reliable pattern is a **`/goal`** (it keeps the agent working until the goal is met), with the same details you'd give a human assistant: how many, what titles, where, which resume, and "review before submitting":

```
/goal apply to 50 jobs with my resume — remote US or hybrid in Austin — for
Software Engineer, Backend Engineer, and Full Stack roles. Review every answer
before submitting so nothing is junk, and only count successful submissions.
```

```
/goal apply to 200 remote Product Manager and Program Manager jobs using my
primary persona. If a form asks whether the application was prepared by AI, say no.
Skip anything requiring security clearance. Count only confirmed submissions.
```

```
/goal find and apply to 30 Data Analyst / Data Quality roles (remote or hybrid
Texas). Proof-read each application before you submit it, and don't apply to the
same job twice.
```

Smaller, conversational asks also work:

```
go                          (discover + apply toward the SESSION_TARGET in CLAUDE.md)
discover 300 jobs for my primary persona, then apply to the best 25
apply to the jobs in jobs.txt
do a DRY RUN on the next 3 jobs so I can review the answers before any real submit
how many have I applied to today? show me the breakdown by company
```

**From the terminal.** One command does discovery, the apply batches, and a summary:

```bash
npm run go -- primary --dry-run --max 3   # fill + screenshot 3 jobs, submit nothing
npm run go -- primary --max 25            # the real thing: 25 submissions
npm run go -- primary --tailor            # also tailor the resume to each posting (opt-in)
```

`npm run go` submits by default (you typed it, you meant it); `--dry-run` is one flag away. Dry-run screenshots land in `.state/runs/dryrun/`, logs in `.state/runs/logs/`.

<details>
<summary>Step-by-step commands, if you'd rather run each stage yourself</summary>

```bash
# 1) Discover jobs for a persona → builds queue-<persona>.json
PERSONA=primary node src/discover-api.js --max 800

# 1b) Optional: grow the company-token pool first, so step 1 has more to sweep
node src/discover-hn.js                    # "Ask HN: Who is hiring?" threads
node src/discover-community.js             # community registry of confirmed job URLs
node src/discover-aggregators.js           # 7 public remote boards → validated tokens

# 2) Apply (one fresh-browser batch)
PERSONA=primary SESSION_TARGET=25 node src/index.js

# 3) Or run continuously to a target (fresh browser per batch, self-healing)
PERSONA=primary TARGET=100 BATCH=25 node src/run-loop.js
```

`DRY_RUN=1` fills every field and screenshots **without submitting**.
</details>

**Location filtering:** discovery keeps **remote-US** roles for everyone by default. To *also* keep **hybrid** roles in your area, either fill your `city`/`state` in `personas.js` (the agent uses them automatically) or set `HYBRID_METRO` for a run:

```bash
PERSONA=primary HYBRID_METRO="Austin,Round Rock,TX,Texas" node src/discover-api.js
```

If neither is set, hybrid roles are skipped (you still get all the remote-US jobs).

### 5. Check your results

```bash
npm run agent -- digest --since 1d       # what ran today: applied, skipped, errors
npm run review                            # what actually converted, by source and score band
```

Everything you applied to is in `applications-log.csv` and the ledger in `.state/` — neither is ever committed.

**Tips that map to how it's built:**
- Always say **"review/proof-read before submitting"** and **"only count successful"** — the agent has a proof-read pass and logs only confirmed submissions, and saying so reinforces it.
- Name the **titles, location, and resume/persona** explicitly — vague asks get vague targeting.
- For big runs, ask it to **run in batches with a fresh browser** (it does this via `run-loop.js`) so long sessions don't degrade.
- **Dry-run first** whenever you change your profile, to eyeball answer quality before going live.

---

# Part 2 — Running nightly on a server

Put the agent on an always-on Linux box and let it apply overnight, every night, while your laptop is closed. You get a summary in the morning.

**What runs unattended:**
- **The nightly orchestrator** — takes every persona in turn toward its target (one short round each per cycle, so nobody starves), runs discovery, applies, and stops before the next night starts. It never overlaps itself.
- **Safety by default** — every scheduled run is a **dry run unless you pass `--live`**, a run caps itself with `--max`, and the same job is never applied to twice, even across machines.
- **Self-checks** — before each round it verifies resumes, browser logins, disk space and data format, and refuses to start rather than fail halfway.
- **Optional extras** — several browsers for one persona at once (parallel sessions), a watchdog that restarts them, a Telegram summary, and an alert when a profile gets signed out of Google.

### What you need

- A **Linux server** (Ubuntu/Debian, x86-64 — Google Chrome has no Linux ARM build) — a cloud VM or a spare machine. Budget **~2 GB of RAM per browser** you run at once. Run the agent as a normal user, not root.
- **Node 20+**, **Google Chrome** (`google-chrome-stable`), **xvfb** (a virtual screen) and **x11vnc** (to log in once).
- **A private place for your profile.** Your filled-in `src/personas.js` and resumes contain your identity — never push them to a public fork. Either click **"Use this template" → Private** on GitHub, or copy those files to the server with `scp`.

```bash
sudo apt-get install -y xvfb x11vnc
# Chrome: https://www.google.com/chrome/ → .deb, then: sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
```

### 1. Bootstrap the server

```bash
# on the server
git clone <your private copy> job-agent && cd job-agent

# on your laptop — only if your resumes and personas.js aren't in your private repo
scp Resume/*.pdf you@server:~/job-agent/Resume/
scp src/personas.js you@server:~/job-agent/src/

# back on the server
bash scripts/bootstrap.sh
```

`bootstrap.sh` installs dependencies and hands over to `npm run doctor`, which checks Node, Playwright, **real Chrome**, `xvfb`, disk, the ledger, and every persona's resume and browser login. Every failure prints exactly what to do about it.

### 2. Log in once per profile, over VNC

A server has no screen, so do the one-time login through VNC. On the server:

```bash
bash scripts/login-profile.sh primary
```

It starts a virtual screen with a VNC server on it (localhost only) and opens Chrome there on that persona's profile. Then on your laptop:

```bash
ssh -N -L 5900:localhost:5900 you@server     # leave this running
```

and open a VNC viewer at `localhost:5900` (macOS: Finder → Go → Connect to Server → `vnc://localhost:5900`; Windows: TigerVNC or RealVNC). Sign in to Google first (needed to read the email security codes some ATSs send), then LinkedIn, and close Chrome — the script saves the login and exits. Repeat for each profile (`secondary`, …). `npm run doctor` confirms every profile is logged in.

> **Never copy a browser profile from your laptop.** A profile carries the device fingerprint of the machine that made it; a copied one is exactly what CAPTCHA scoring flags. Each machine logs in once, itself. And never switch the browser to `headless` to "fix" a server problem — headless sessions get silently rejected. The scripts run real Chrome on the virtual screen for you (`scripts/with-display.sh`).

### 3. Test with a dry run

```bash
scripts/nightly-run.sh primary --max 3          # dry run (the default): fills + screenshots, submits nothing
ls .state/runs/dryrun/                          # look at the screenshots
```

The command prints one JSON summary (the digest) on stdout; the detail is in `.state/runs/logs/`. When the screenshots look right, add `--live`.

The template ships with an **empty company list** (no one else's data). The first discovery fills it automatically from "Ask HN: Who is hiring?" — about 100 companies. For a much bigger pool, run this once (a few minutes):

```bash
npm run seed       # 6 months of Ask HN threads + 7 public remote job boards
```

### 4. Schedule the night

`crontab -e` on the server (times are UTC). Cron starts jobs with a bare `PATH`, so give it the folder Node lives in — run `dirname $(which node)` and put that first:

```cron
PATH=/home/you/.nvm/versions/node/v22.11.0/bin:/usr/local/bin:/usr/bin:/bin
# every night at 01:00 UTC: all personas, real submissions, up to 50 each
0 1 * * *  cd /home/you/job-agent && bash scripts/nightly-orchestrator.sh --live >> .state/runs/logs/cron.log 2>&1
```

(The scripts also look in the usual nvm/volta/`/usr/local` places if Node isn't on `PATH`, but the explicit line is what to rely on.)

Tune it with environment variables in front of the command:

| Variable | Default | What it does |
|---|---|---|
| `TARGET` | `50` | Submissions per persona per night |
| `TARGET_<PERSONA>` | — | Per-persona override, e.g. `TARGET_PRIMARY=75` |
| `PERSONAS` | every persona | Which personas run, e.g. `"primary secondary"` |
| `PRIORITY_PERSONA` | — | Always goes first each cycle |
| `MAX_ROUNDS` | `8` | Cycles through the personas per night |
| `MAX_EVAL_CAP` | `150` | Listings evaluated per round (keeps rounds short) |
| `NEXT_START_UTC` | `01:00` | Your cron time — the run stops 15 min before the next one |

### 5. More throughput (optional)

**Parallel sessions** — one persona as several browsers at once, each with its own profile and queue, one shared ledger so no job is applied to twice. In `src/personas.js` set `PARALLEL_SESSIONS = { primary: 3 }`, log in once to `browser-profile-primary2` and `-primary3` (step 2), then let the watchdog keep them running all day:

```cron
*/5 * * * *  cd /home/you/job-agent && bash scripts/watchdog-sessions.sh primary 3 --live
```

**A one-off push** — get one persona to a number right now, outside the night:

```bash
scripts/persona-push.sh primary 75      # stops after two rounds in a row with no gain (--dry-run to rehearse)
```

### 6. Morning summary and alerts (optional)

Create a Telegram bot with [@BotFather](https://t.me/BotFather), then on the server:

```bash
cat > ~/.telegram_notify_credentials <<'EOF'
TELEGRAM_BOT_TOKEN=123456:abc...
TELEGRAM_CHAT_ID=123456789
EOF
chmod 600 ~/.telegram_notify_credentials
```

You'll get a message when each night ends (applied vs. target per persona, errors, duration), and an alert if a browser profile loses its Google login (`scripts/gmail-session-check.py`, run before each night). Set `NOTIFY_TZ=America/New_York` for local times. Without credentials, both just print.

### 7. Laptop and server together (optional)

You can keep applying from your laptop while the server runs nightly. Both share one history if you point them at the same S3 bucket (needs the `aws` CLI). Set these as environment variables on both machines — in your shell profile, and as lines at the top of the server's crontab, since cron doesn't read your profile:

```bash
APPLY_AGENT_STATE_S3=s3://your-bucket/apply-agent
APPLY_AGENT_STATE_S3_PROFILE=runner                 # aws CLI profile with read AND write
```

`npm run doctor` confirms the profile can both read and write the bucket.

Locks make sure the two machines never use the same browser profile at the same time, and duplicate checks hold across both. Browser profiles are never synced.

### Day to day

```bash
npm run agent -- digest --since 1d                 # last night's results
npm run agent -- round list                        # recent runs
npm run agent -- round stop --round <id>           # stop gracefully (finishes the job in flight)
npm run agent -- round locks                       # who holds which profile, and how stale
npm run agent -- round unlock --force --persona primary   # only if that run is definitely dead
npm run agent -- gc                                # clean old screenshots, logs, rendered PDFs
```

The full operator's guide — locks, S3, resume tailoring storage, the orchestrator endpoints — is in **[ONBOARDING.md → Running on a second machine](ONBOARDING.md)**.

---

# How it works (both setups)

## Two agents: one fills, one reviews (accuracy pass)

Keyword heuristics alone can still get *custom screening questions* wrong — claiming a
certification/degree/skill you don't have, putting a country where a city belongs, and so on.
To catch that, there's an optional **multi-agent fill → review pipeline** (`workflows/fill-review-applications.js`,
run via Claude Code's `Workflow` tool):

1. **Fill agent** — fetches a job's *real* questions (`node src/dump-questions.js <url>`, Greenhouse's public
   question API) and drafts an answer for each from your resume facts.
2. **Review agent** — an *independent* agent audits every answer against your resume, corrects overclaims,
   and **rejects jobs that require a credential/license/language you don't have**.
3. The vetted answers are written to `data/verified-answers.json`, which the ATS handlers read **first**
   (`src/util/verified.js`) — so the real submission uses reviewed answers, not guesses.
   `src/apply-verified.js` merges them and builds an approved-only queue.

Your resume facts are passed to the pipeline at run time and are **never stored in the repo** — no PII is committed.

## Honesty is derived from your profile — nothing hardcoded

Every demographic, education, and experience answer is computed from your persona (`src/personas.js`), so the
agent stays truthful for **any** background:

- **Gender / race / pronouns / veteran / disability** are matched from your own values (`src/util/eeo.js`) — no hardcoded defaults. Leave one as a placeholder and the form gets "decline to answer", never a guess.
- **Education** is answered by *rank*: it never claims a credential above your highest degree, and picks your real
  level from a dropdown (or leaves it blank) rather than inventing a degree. "Do you have a Bachelor's?" → honest Yes/No.
- **Years of experience** for a *specific* tool returns your real total only if that skill is on your resume
  (set `skills` in your persona) — otherwise **0**, never an invented number.
- **School** fields fill your real school or stay blank — never a random autocomplete match.
- **Cover letters** are only attached when a form strictly *requires* one.
- **Referrals / "do you know anyone here?"** → answered "No" (unless your facts say otherwise), never fabricated.
- **Resume tailoring** (opt-in, `--tailor`) only rewords and reorders what your base resume already says, and is checked before upload.

## What makes the applications *good* (quality, not just quantity)

This isn't a blind form-filler. The pieces that get real responses:

- **Schema-driven Greenhouse fill** — reads each job's public question schema and answers every field by its exact name, so nothing is missed or mismatched.
- **Skill-specific answers** (`src/answer-bank.js`) — "Describe your experience with X" gets a real answer *about X*, not a generic blurb. A named-skill fallback means even unmapped questions stay on-topic.
- **EEO / demographics** answered consistently and correctly from your persona (disability, veteran, race, gender, Hispanic, EEO disclaimers).
- **Cover letters** generated per-job (textarea *and* file-upload forms).
- **A proof-read pass before every submit** that catches and fixes nonsense (e.g. a location stuffed into a "who referred you?" field).
- **Honesty guardrails** — never claims to be a government official / protected veteran / to have a disability you don't have; answers "previously worked here?" and referral questions correctly.
- A **learned-answers store** that remembers good answers to novel questions so they stay consistent across applications (you can hand-edit `data/learned-answers.json`).
- **Company rules** — never the same role at a company twice, one persona per company, commission-only "jobs" filtered out, and your own blocklist (`data/personal-exclude.json`, gitignored) for current interviews and former employers.

## How it gets past CAPTCHAs

It launches **your real, installed Chrome** with a persistent profile (`channel: 'chrome', headless: false`) instead of headless Chromium. With a normal browser fingerprint and a warm session:

- **Greenhouse's invisible reCAPTCHA Enterprise** scores the session and passes silently.
- **Lever's passive hCaptcha enclave** passes silently.
- Interactive challenges (rare) pause for a human, or can use a 2captcha key (`TWOCAPTCHA_KEY`). DataDome / Cloudflare-Turnstile-walled tenants are detected and skipped fast rather than hanging.

(See `src/util/captcha.js`.) Headless bundled Chromium gets a stripped/bot-flagged form — that's why real Chrome matters, and why a server runs real Chrome on a virtual screen rather than headless.

## Reliability

- **Fresh-browser batching** (`src/run-loop.js`) — a long Playwright session degrades after ~30–50 jobs; the loop runs small batches each with a fresh browser, with a **watchdog** that force-kills a hung batch and a **browser-death abort** so a dead browser never silently burns your queue.
- **Per-job timeout**, **crash/restart-safe** logging (every job written immediately), and **strict dedup** across all runs and machines.

## Accounts on Workday, iCIMS and Jobvite

These make you create an account per employer. Copy `data/ats-accounts.example.json` to `data/ats-accounts.json` (gitignored) and fill in each persona's email and a **unique** password for that file — never reuse a real one. Without it, those applications stop with a "no ATS credentials" error and the run moves on.

---

## The decision layer (`apply-agent` CLI)

Browser automation is only half the job. Everything that must **not** be decided
from memory — is this a duplicate, is this a good enough fit, may I submit
without asking, what actually converted — lives behind a dependency-free CLI:

```bash
node bin/apply-agent.js help
```

| Command | What it settles |
|---|---|
| `doctor` | Is this machine ready to run? Every failure comes with its fix |
| `score --stdin` | A **gate before the number**: `exclude` / `ask` / `skip` / `review`, plus `autoEligible` (necessary, never sufficient, to auto-submit) |
| `ledger check --stdin` | Four-way duplicate check — ledger id, canonical URL, employer job id, requisition — plus a same-company reapply cooldown |
| `ledger add --stdin` | Records a submission. **Refuses an entry with no confirmation evidence** — a filled form is not a submission |
| `ledger outcome --stdin` | Structured outcomes (`rejected`, `interview`, `offer`, …) with a reason marked `explicit` or `inferred` |
| `ledger review` | Unique submissions, duplicate rows, and response/positive rates by discovery source, channel, score band and persona — over applications old enough to have heard back |
| `autonomy grant/status/revoke` | `review-each` vs `routine-auto`, time-boxed and scopable to one persona or batch. Some things stop in **every** mode |
| `attention add/list/resolve` | Park what needs *you* (login, CAPTCHA, a duplicate call) instead of losing it to an `Error` row |
| `friction record/list` | Reproducible tooling failures, aggregated by signature — never blocks an application |
| `round start/status/complete/stop/locks` | One ID across every fresh-browser batch, so an overnight run is a single addressable unit — with cross-machine locks |
| `digest` | A run's results as one JSON document (or a short `--format telegram` message) |
| `profile set/check/field` | Identity in the **OS keychain** (macOS Keychain, Windows DPAPI, libsecret) — not in a tracked file |
| `sources list/add` | Versioned local discovery-source catalog |
| `state pull/push` | Optional S3 sync of the ledger between machines (never browser profiles) |
| `migrate` | Backfills `applications-log.csv` into the ledger so history works from day one |

Every command reads JSON on stdin and writes JSON to stdout, so it composes with
Claude Code, a shell script, or the Playwright runner. The runner calls
`ledger check` before each application and `ledger add` after each confirmed
submission automatically.

### Why the ledger beats the CSV

The CSV deduped on an exact URL string. The ledger canonicalizes first, so one
requisition collapses across `boards.` vs `job-boards.greenhouse.io`, an
`/application` suffix, and any tracking params — and it still catches the case
where the *same job* arrives from a second discovery source. Backfilling the
existing history surfaced 21 applications that had been submitted twice.

```bash
node bin/apply-agent.js migrate      # one-time backfill; the CSVs stay untouched
node bin/apply-agent.js ledger review
```

### Privacy

Nothing leaves the machine — no telemetry, no community registry, no analytics
endpoint. `.state/` holds the ledgers and is gitignored. CI runs a privacy audit
that **fails the build** if a ledger, browser profile, resume, secret or real
candidate PII ever reaches a tracked file — and the run scripts run it before they
commit anything:

```bash
npm run privacy-audit             # local tree: blocking findings only
npm run privacy-audit:strict      # also fails on real PII — run before pushing
node scripts/privacy-audit.js --ref origin/main --strict   # audit what is actually published
```

### Tests

```bash
npm test        # 370+ tests: dedup, gates, autonomy, locks, preflight, tailoring, EEO, CLI, ...
npm run check   # syntax check every entry point and script
```

---

## Layout

```
src/
  index.js            apply runner — routes each job URL to its ATS handler
  run-loop.js         batch loop (fresh browser per batch + watchdog)
  discover-api.js     finds jobs via public ATS JSON APIs, filters by role + location
  discover-workday.js sweeps the Workday tenants you list in data/workday-boards.json
  discover-hn.js      harvests company ATS tokens from "Ask HN: Who is hiring?"
  discover-community.js reads the job-application-agent community job registry (GET only)
  discover-aggregators.js seeds tokens from 7 public remote boards (see src/feeds.js)
  feeds.js            RSS/JSON clients for the non-ATS boards
  util/eligibility.js one shared role/location/recency filter for every discovery runner
  import-companies.js bulk-imports public ATS company-token datasets
  personas.js   ←── YOUR identity + answers (edit this)
  answer-bank.js ←── screening-question answer engine (customize for your field)
  ats/                Greenhouse / Lever / Ashby / Workable / SmartRecruiters / CareerPuck /
                      Workday / iCIMS / Jobvite / BambooHR / Breezy / Rippling handlers
  util/               form-fill, location, captcha, answer-mapping, EEO, email-OTP, learned-answers
  core/               ledger, rounds, locks, preflight/doctor, digest, state sync
  resume/             resume verify, upload, opt-in tailoring and rendering
scripts/
  go.sh               `npm run go -- <persona>` — Part 1's one-command run
  nightly-run.sh      the same run for schedules (dry run unless --live)
  nightly-orchestrator.sh  Part 2: every persona, all night, from cron
  parallel-session.sh one persona as N browsers; watchdog-sessions.sh keeps them up
  persona-push.sh     get one persona to a number now
  bootstrap.sh        set up a new machine, then `npm run doctor`
  login-profile.sh    log a persona in once on a headless server, over VNC
  notify-telegram.py, gmail-session-check.py   optional alerts
data/companies.json   public ATS company tokens (the discovery seed) — shareable, no personal data
CLAUDE.md             instructions + setup wizard for Claude Code
ONBOARDING.md         the full walkthrough, including the server operator's guide
applications-log.csv  every submission (dedup source of truth) — starts empty
seen-jobs.csv         every job evaluated (dedup) — starts empty
```

**Never committed** (gitignored): your `Resume/*`, `browser-profile-*/` (login cookies — keep these private!), `.state/` (the ledger), `data/ats-accounts.json` (ATS passwords), `data/personal-exclude.json` (your company blocklist), generated cover letters, and your real `applications-log.csv` / `seen-jobs.csv` once you start running.

---

## Notes

- Applications are submitted **only on the company's real ATS**, never via a job-board's "Easy Apply" (those are anti-automation and risk your account).
- The agent skips roles requiring active security clearance / US citizenship if your profile says you can't meet them, and skips non-US / wrong-location roles.
- This is a tool to save you time on the tedious parts of a real job search — review your `applications-log.csv`, follow up, and prep for the interviews it earns you.
