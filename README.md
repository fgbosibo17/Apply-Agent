# Autonomous Job-Application Agent

An AI-driven agent that **finds remote/hybrid jobs and applies to them for you** — end to end, on the company's real ATS (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, CareerPuck). It discovers fresh openings, scores fit, fills every form field intelligently from your profile, writes tailored screening answers, **proof-reads before submitting**, and logs everything so it never applies to the same job twice.

It's built to be driven by **[Claude Code](https://claude.com/claude-code)** (talk to it: "setup", then "go"), but the core is plain Node + Playwright and runs on its own too.

> ⚠️ **Use this on your own behalf, with your own data, for jobs you'd genuinely take.** It submits real applications to real employers. Don't mass-spam. Keep your answers truthful to your resume.

---

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

- **Gender / race / pronouns** are matched from your own values — no hardcoded defaults.
- **Education** is answered by *rank*: it never claims a credential above your highest degree, and picks your real
  level from a dropdown (or leaves it blank) rather than inventing a degree. "Do you have a Bachelor's?" → honest Yes/No.
- **Years of experience** for a *specific* tool returns your real total only if that skill is on your resume
  (set `skills` in your persona) — otherwise **0**, never an invented number.
- **School** fields fill your real school or stay blank — never a random autocomplete match.
- **Cover letters** are only attached when a form strictly *requires* one.
- **Referrals / "do you know anyone here?"** → answered "No" (unless your facts say otherwise), never fabricated.

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

Then drop your resume(s) into `Resume/` and use the ready-made prompts in
**[`prompts/`](prompts/)** — fill in the blanks and paste into Claude Code:

- **[`prompts/01-first-run.md`](prompts/01-first-run.md)** — first time: reads your resume,
  builds your profile, asks what it can't find, then applies (review-before-submit).
- **[`prompts/02-subsequent-runs.md`](prompts/02-subsequent-runs.md)** — every run after: skips
  setup and applies to more jobs.

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

**Location filtering:** discovery keeps **remote-US** roles for everyone by default. To
*also* keep **hybrid** roles in your area, either fill your `city`/`state` in `personas.js`
(the agent uses them automatically) or set `HYBRID_METRO` for a run:

```bash
PERSONA=primary HYBRID_METRO="Austin,Round Rock,TX,Texas" node src/discover-api.js
```

If neither is set, hybrid roles are skipped (you still get all the remote-US jobs).

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

> **Two run paths, one set of facts.** Driving it **with Claude Code** ("setup" → "go") fills forms from the `📝 APPLICATION ANSWERS` block in `CLAUDE.md`. Running the **node loop** headlessly reads `src/personas.js`. The `setup` wizard fills **both**; if you edit by hand, keep the two in sync (they hold the same identity + answers).

---

## Driving it with Claude Code — example prompts

Open the folder in [Claude Code](https://claude.com/claude-code) and talk to it. The most reliable pattern is a **`/goal`** (it keeps the agent working until the goal is met), with the same details you'd give a human assistant: how many, what titles, where, which resume, and "review before submitting."

**First-time setup**
```
setup
```
> Reads your resume, fills your profile + personas.js, and walks you through browser logins.

**Then kick off applications with a /goal:**
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

**Smaller, conversational asks also work:**
```
go                          (discover + apply toward the SESSION_TARGET in CLAUDE.md)
discover 300 jobs for my primary persona, then apply to the best 25
apply to the jobs in jobs.txt
do a DRY RUN on the next 3 jobs so I can review the answers before any real submit
how many have I applied to today? show me the breakdown by company
```

**Tips that map to how I built it:**
- Always say **"review/proof-read before submitting"** and **"only count successful"** — the agent has a proof-read pass and logs only confirmed submissions, and saying so reinforces it.
- Name the **titles, location, and resume/persona** explicitly — vague asks get vague targeting.
- For big runs, ask it to **run in batches with a fresh browser** (it does this via `run-loop.js`) so long sessions don't degrade.
- Use **`DRY_RUN`** ("do a dry run first") to eyeball answer quality before going live.

---

## Notes

- Applications are submitted **only on the company's real ATS**, never via a job-board's "Easy Apply" (those are anti-automation and risk your account).
- The agent skips roles requiring active security clearance / US citizenship if your profile says you can't meet them, and skips non-US / wrong-location roles.
- This is a tool to save you time on the tedious parts of a real job search — review your `applications-log.csv`, follow up, and prep for the interviews it earns you.
