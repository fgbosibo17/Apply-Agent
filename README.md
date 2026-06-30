# Autonomous Job-Application Agent

An AI-driven agent that **finds remote/hybrid jobs and applies to them for you** — end to end, on the company's real ATS (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, CareerPuck). It discovers fresh openings, scores fit, fills every form field intelligently from your profile, writes tailored screening answers, **proof-reads before submitting**, and logs everything so it never applies to the same job twice.

It's built to be driven by **[Claude Code](https://claude.com/claude-code)** (talk to it: "setup", then "go"), but the core is plain Node + Playwright and runs on its own too.

> ⚠️ **Use this on your own behalf, with your own data, for jobs you'd genuinely take.** It submits real applications to real employers. Don't mass-spam. Keep your answers truthful to your resume.

---

## What makes the applications *good* (quality, not just quantity)

This isn't a blind form-filler. The pieces that get real responses:

- **Schema-driven Greenhouse fill** — reads each job's public question schema and answers every field by its exact name, so nothing is missed or mismatched.
- **Skill-specific answers** (`src/answer-bank.js`) — "Describe your experience with X" gets a real answer *about X*, not a generic blurb. A named-skill fallback means even unmapped questions stay on-topic.
- **EEO / demographics** answered consistently and correctly (disability, veteran, race, gender, Hispanic, EEO disclaimers).
- **Cover letters** generated per-job (textarea *and* file-upload forms).
- **A proof-read pass before every submit** that catches and fixes nonsense (e.g. a location stuffed into a "who referred you?" field).
- **Honesty guardrails** — never claims to be a government official / protected veteran / to have a disability you don't have; answers "previously worked here?" and referral questions correctly.
- A **learned-answers store** that remembers good answers to novel questions so they stay consistent across applications (you can hand-edit `data/learned-answers.json`).

## How it gets past CAPTCHAs

It launches **your real, installed Chrome** with a persistent profile (`channel: 'chrome', headless: false`) instead of headless Chromium. With a normal browser fingerprint and a warm session:

- **Greenhouse's invisible reCAPTCHA Enterprise** scores the session and passes silently.
- **Lever's passive hCaptcha enclave** passes silently.
- Interactive challenges (rare) pause for a human, or can use a 2captcha key (`TWOCAPTCHA_KEY`). DataDome / Cloudflare-Turnstile-walled tenants are detected and skipped fast rather than hanging.

(See `src/util/captcha.js`.) Headless bundled Chromium gets a stripped/bot-flagged form — that's why real Chrome matters.

## Reliability

- **Fresh-browser batching** (`src/run-loop.js`) — a long Playwright session degrades after ~30–50 jobs; the loop runs small batches each with a fresh browser, with a **watchdog** that force-kills a hung batch and a **browser-death abort** so a dead browser never silently burns your queue.
- **Per-job timeout**, **crash/restart-safe** logging (every job written immediately), and **strict dedup** across all runs.

---

## Quick start

```bash
npm install
npx playwright install chrome    # uses your real Chrome channel
```

Then **either** drive it with Claude Code (recommended):

1. Open this folder in Claude Code (`claude`).
2. Drop your resume PDF into `Resume/`.
3. Say **`setup`** — it reads your resume, fills your profile, and walks you through browser logins.
4. Say **`go`** — it discovers and applies.

**Or** configure it by hand:

1. Drop your resume(s) into `Resume/`.
2. Edit **`src/personas.js`** — your name, email, phone, location, work authorization, EEO answers, salary, target job titles (`matchKeywords`/`targetRoles`), and `resumePath`. It's all `<FILL_ME_IN>` placeholders to start.
3. Customize **`src/answer-bank.js`** — the example skills/answers are for tech roles; edit them for *your* field so screening answers ring true.
4. (Optional) `node setup-browser-login.js <persona>` to sign into job boards once (stored in a gitignored browser profile).

### Run it

```bash
# 1) Discover jobs for a persona → builds queue-<persona>.json
PERSONA=primary node src/discover-api.js --max 800

# 2) Apply (one fresh-browser batch)
PERSONA=primary SESSION_TARGET=25 node src/index.js

# 3) Or run continuously to a target (fresh browser per batch, self-healing)
PERSONA=primary TARGET=100 BATCH=25 node src/run-loop.js
```

`DRY_RUN=1` fills every field and screenshots **without submitting** — use it to verify quality before going live.

---

## Layout

```
src/
  index.js            apply runner — routes each job URL to its ATS handler
  run-loop.js         batch loop (fresh browser per batch + watchdog)
  discover-api.js     finds jobs via public ATS JSON APIs, filters by role + location
  discover-hn.js      harvests company ATS tokens from "Ask HN: Who is hiring?"
  import-companies.js bulk-imports public ATS company-token datasets
  personas.js   ←── YOUR identity + answers (edit this)
  answer-bank.js ←── screening-question answer engine (customize for your field)
  ats/                Greenhouse / Lever / Ashby / Workable / SmartRecruiters / CareerPuck handlers
  util/               form-fill, location, captcha, answer-mapping, email-OTP, learned-answers
data/companies.json   public ATS company tokens (the discovery seed) — shareable, no personal data
CLAUDE.md             instructions + setup wizard for Claude Code
applications-log.csv  every submission (dedup source of truth) — starts empty
seen-jobs.csv         every job evaluated (dedup) — starts empty
```

**Never committed** (gitignored): your `Resume/*`, `browser-profile-*/` (login cookies — keep these private!), generated cover letters, and your real `applications-log.csv` / `seen-jobs.csv` once you start running.

---

## Notes

- Applications are submitted **only on the company's real ATS**, never via a job-board's "Easy Apply" (those are anti-automation and risk your account).
- The agent skips roles requiring active security clearance / US citizenship if your profile says you can't meet them, and skips non-US / wrong-location roles.
- This is a tool to save you time on the tedious parts of a real job search — review your `applications-log.csv`, follow up, and prep for the interviews it earns you.
