# AI Job Application Agent

A fully autonomous job-hunt agent — drop your resume in, run `setup`, then say **`go`**. The agent searches job boards, evaluates fit, fills out applications, and submits them on the company's real ATS — all without you watching.

Built for Claude Code + Playwright. Works on Windows, macOS, and Linux.

---

## 🚀 Quick Start (5 minutes)

### 1. Get the project
Download / clone this folder somewhere on your machine.

### 2. Install dependencies
Open a terminal in this folder and run:
```bash
npm install
npx playwright install chromium
```

### 3. Add the Playwright MCP to Claude Code
One-time setup so Claude can drive a browser:
```bash
claude mcp add playwright -- npx @anthropic-ai/mcp-playwright
```

### 4. Drop your resume into the `Resume/` folder
Put the file inside the `Resume/` subfolder of this project. Any filename works — `Resume/MyResume.pdf`, `Resume/JaneDoe_Resume.docx`, etc. PDF or DOCX. (The folder already exists; if it doesn't, just create it.)

### 5. Run the setup wizard
Open Claude Code in this folder:
```bash
claude
```
Then say:
```
setup
```
The agent will:
- Find your resume in the `Resume/` folder
- Read it and extract name, email, phone, LinkedIn, current job, education, skills
- Auto-fill the `📝 APPLICATION ANSWERS` block in `CLAUDE.md`
- Ask you 6-7 quick questions about things not on your resume (salary expectations, work auth status, demographics for EEO, etc.)
- Confirm everything looks right before saving
- **Open a browser and walk you through logging into LinkedIn** (and optionally Google for ATS OAuth) — you type your password yourself, the agent never touches it. Session is saved in `./browser-profile/` and persists across all future runs.

### 6. Say `go`
```
go
```
That's it. The agent reads your profile, opens its persistent browser (already logged in from setup), finds matching jobs across 25+ ATS platforms, and submits applications. Default target: **40 successful applications per run** (change `SESSION_TARGET` in CLAUDE.md).

---

## 🗓️ Run it daily without opening Claude Code (Windows)

This project ships with a Windows Task Scheduler setup so the agent runs **every weekday at 9 AM**, applies to **50 jobs per run**, and even wakes the PC from sleep.

1. Right-click **`install-schedule.bat`** → "Run as administrator"
2. Done. The task is registered. See "Scheduling" section below for change/disable/uninstall.

---

## ⚙️ Tuning the Agent (all settings live at the top of `CLAUDE.md`)

`CLAUDE.md` has **two YAML config blocks at the top** — change anything in either and the next `go` picks it up.

### Block 1 — `⚙️ SESSION CONFIG` (how the agent runs)

| Setting | What it does | Default |
|---|---|---|
| `SESSION_TARGET` | Applications to submit before stopping | `20` |
| `MAX_JOBS_EVALUATED` | Safety cap on listings opened | `200` |
| `MIN_MATCH_SCORE` | Min score (out of 10) needed to apply | `7` |
| `MIN_SALARY` | Salary floor; jobs below this are skipped | `100000` |
| `LOCATIONS_OK` | Locations to allow | `Remote-US, Hybrid-US (1-2 days/week)` |
| `APPLY_MODE` | `auto` = fire-and-forget · `confirm` = ask first | `auto` |
| `SKIP_CHANNELS` | Channels to skip this session | (none) |
| `PRIORITY_CHANNELS` | Channels to mine first | `greenhouse, lever, ashby, workable` |

### Block 2 — `📝 APPLICATION ANSWERS` (what the agent fills into forms)

Every value the agent types into an application form is editable here. The block is split into **two clearly-labeled tiers**:

#### ✅ REQUIRED — must be filled (the agent NEEDS these)

These show up on almost every application. If any are left as `<FILL_ME_IN>`, the agent will be blocked when that field appears.

| Group | Example keys |
|---|---|
| **Identity** | `FIRST_NAME`, `LAST_NAME`, `EMAIL`, `PHONE_FULL` |
| **Location** | `CITY`, `STATE`, `COUNTRY`, `FULL_ADDRESS_ONE_LINE` |
| **Links** | `LINKEDIN_URL` |
| **Work auth** | `AUTHORIZED_TO_WORK_US`, `NEED_SPONSORSHIP_NOW`, `US_CITIZEN`, `WORK_AUTH_STATUS` |
| **Salary** | `SALARY_MIN`, `SALARY_MAX`, `SALARY_TARGET_SINGLE`, `SALARY_RANGE_STRING` |
| **Start date** | `NOTICE_PERIOD`, `EARLIEST_START_DATE` |
| **Work preferences** | `PREFERRED_WORK_TYPE`, `OPEN_TO_HYBRID`, `WILLING_TO_RELOCATE` |
| **Background / consent** | `CONSENT_BACKGROUND_CHECK`, `CONSENT_DRUG_TEST`, `HAS_NON_COMPETE`, `IS_18_OR_OLDER` |
| **Referral / discovery** | `HOW_DID_YOU_HEAR` |
| **EEO / demographics** | `GENDER`, `RACE`, `ETHNICITY`, `HISPANIC_LATINO`, `VETERAN_STATUS`, `DISABILITY_STATUS` |
| **Employment status** | `CURRENTLY_EMPLOYED`, `REASON_FOR_LEAVING`, `CAN_CONTACT_CURRENT_EMPLOYER` |
| **Engagement type** | `OPEN_TO_FULL_TIME`, `OPEN_TO_CONTRACT` |
| **Role blurb** | `WHY_THIS_ROLE_BLURB`, `ELEVATOR_PITCH` |
| **Attestations** | `CERTIFY_TRUTHFUL_ANSWERS`, `AGREE_TO_TERMS`, `AGREE_TO_PRIVACY_POLICY` |
| **Education** | `HIGHEST_DEGREE`, `HIGHEST_DEGREE_FIELD`, `HIGHEST_DEGREE_SCHOOL`, `UNDERGRAD_*` |
| **Current job** | `CURRENT_EMPLOYER`, `CURRENT_TITLE`, `TOTAL_YEARS_EXPERIENCE` |
| **Resume** | `RESUME_FILE` |
| **Cover letter** | `COVER_LETTER_ENABLED`, `COVER_LETTER_TONE`, `COVER_LETTER_LENGTH` |

#### ⚪ OPTIONAL — leave blank and Claude figures it out

You **don't have to fill any of these.** When a form asks for an optional field that's blank, Claude infers from your REQUIRED fields + resume + the job description — it doesn't skip and it doesn't stop to ask.

Fill an optional value only when you want a **specific** answer locked in (e.g. you want PTO_EXPECTATION to be exactly "25 days"). A filled value always beats the inference.

**Sensitive fields** (current salary, references, DOB, SSN) get safe defaults like *"Prefer not to disclose"* or *"Available upon request"* — Claude never invents numbers or fabricates references.

### Override rules (the agent obeys this order)

1. **What you say in chat** beats both files (e.g. *"apply to 50 jobs today"*, *"only $150k+ Staff roles"*).
2. **`📝 APPLICATION ANSWERS`** beats the Standard Answers fallback table.
3. **`⚙️ SESSION CONFIG`** beats hardcoded defaults in the rest of CLAUDE.md.

---

## 🎮 How to Run

### In the terminal:
```bash
claude
```

### Then tell it what to do:

**Full auto:**
```
go
```

**One-off override:**
```
apply to 50 jobs today
```

**Specific board:**
```
search Wellfound for staff QA roles. apply to everything 8+ match.
```

**Resume check mode:**
```
search Greenhouse for senior automation roles. show me the match score and job title before applying. only apply to 8+ matches.
```

---

## 📁 Project Structure

```
job-agent/
├── CLAUDE.md                          ← Agent brain — your profile + rules (Claude Code auto-reads)
├── README.md                          ← This file
├── package.json                       ← Node deps
├── package-lock.json
├── node_modules/                      ← (generated by npm install)
│
├── Resume/                            ← YOU drop your resume in here (any filename, PDF or DOCX)
│   └── <your-resume>.pdf
│
├── jobs.txt                           ← Optional: paste specific URLs to apply to
├── applications-log.csv               ← Generated — tracks all applications (header only at start)
├── seen-jobs.csv                      ← Generated — every job evaluated (skip duplicates)
├── session-state.json                 ← Generated — crash recovery state
├── ats-accounts.txt                   ← Generated — ATS platforms with accounts
├── scheduled-runs.log                 ← Generated — output from scheduled runs
│
├── cover-letters/                     ← Generated — tailored cover letters per job
├── browser-profile/                   ← Generated — persistent browser (logins, cookies, sessions)
│
├── run-job-agent.bat                  ← Launcher for Windows Task Scheduler
├── job-agent-schedule.xml             ← Task Scheduler definition
├── install-schedule.bat               ← One-time setup for daily schedule
└── uninstall-schedule.bat             ← Removes the daily schedule
```

---

## 🗓️ Scheduling (Windows — daily at 9 AM)

The project ships with a Windows Task Scheduler setup that runs the agent every weekday at 9 AM local time and applies to up to 50 jobs per run — fully unattended, even waking the PC from sleep.

### Files involved

| File | Purpose |
|---|---|
| `run-job-agent.bat` | Launcher — invokes `claude -p` headlessly with the daily prompt and logs to `scheduled-runs.log` |
| `job-agent-schedule.xml` | Task Scheduler definition (weekdays @ 9 AM, wake-on-schedule, 4h max runtime, restart-on-failure ×3) |
| `install-schedule.bat` | One-time setup — registers the task in Windows Task Scheduler |
| `uninstall-schedule.bat` | Removes the scheduled task |
| `scheduled-runs.log` | Auto-generated — captures stdout/stderr from every scheduled run |

### One-time install

1. **Right-click `install-schedule.bat` → "Run as administrator"** (admin is required because the task wakes the PC from sleep).
2. You'll see a confirmation in the terminal. The task is now registered.
3. To verify: open **Task Scheduler** (search "Task Scheduler" in Start), expand **Task Scheduler Library**, look for **JobApplicationAgent**.

### Quick commands

```bat
:: Run now (don't wait for 9 AM tomorrow)
schtasks /run /tn "JobApplicationAgent"

:: Disable temporarily
schtasks /change /tn "JobApplicationAgent" /disable

:: Re-enable
schtasks /change /tn "JobApplicationAgent" /enable

:: Remove entirely
uninstall-schedule.bat
```

### Change the schedule

Edit `job-agent-schedule.xml` and re-run `install-schedule.bat`.

| Change | What to edit |
|---|---|
| Different time of day | `<StartBoundary>...T09:00:00</StartBoundary>` — change the `T09:00:00` portion |
| Different days | The `<DaysOfWeek>` block — add/remove `<Saturday />`, etc. |
| Different per-run target | Edit `run-job-agent.bat` — change `apply to 50 jobs today` in the prompt |
| Don't wake the PC | Change `<WakeToRun>true</WakeToRun>` to `false` |
| Longer runtime allowed | `<ExecutionTimeLimit>PT4H</ExecutionTimeLimit>` — PT8H = 8 hours, etc. |

### Important caveats

- **Must be logged in to Windows** for the task to run (uses `InteractiveToken`).
- **Computer must be on or asleep** (not powered off / hibernated indefinitely). Wake-on-schedule wakes from sleep, not from full shutdown.
- **No terminal needs to be open** — Claude Code runs headlessly in the background.
- **First run after install:** test with `schtasks /run /tn "JobApplicationAgent"` and watch `scheduled-runs.log` to confirm everything works.

---

## 🛟 What Happens When You Say "Go"

```
You: "go"
  ↓
Claude reads CLAUDE.md (SESSION CONFIG + APPLICATION ANSWERS + agent rules)
  ↓
Opens browser at ./browser-profile (your persisted LinkedIn / Google sessions)
  ↓
Sources jobs aggressively:
  Tier 1 ATS (Greenhouse, Lever, Ashby, Workable, Workday, iCIMS, ...) via Google site: searches
  Tier 2 boards (LinkedIn, Indeed, Wellfound, BuiltIn, Dice, Glassdoor, Remote-OK, ...)
  Tier 3 general Google queries
  Tier 4 direct company career pages
  ↓
For each job: opens, reads JD, scores against your profile (need 3+ match criteria)
  ↓
Match? → Click through to company's real ATS → fill out application from APPLICATION ANSWERS
          → upload your resume → write cover letter (if required) → submit
No match? → Skip → log reason → next job
  ↓
Always applies on the company's ATS (Greenhouse, Lever, Workday, etc.) — never on the job board
  ↓
Logs every job to applications-log.csv and seen-jobs.csv (so duplicates never happen)
  ↓
Repeats until SESSION_TARGET hit (default: 20)
  ↓
Gives you a summary: "Applied 18, Skipped 12, Errors 4, top matches: ..."
```

---

## 💡 Tips

- **First run:** watch the first 2-3 applications go through, make sure form-filling looks right
- **Google ATS searches** are the most reliable — they link straight to Greenhouse/Lever/Ashby applications
- **LinkedIn, Indeed, Dice** are discovery only — agent always clicks through to the company's real ATS
- **Workday / iCIMS** sites are trickier and slower (multi-page forms) but the agent adapts
- **CAPTCHAs:** the agent stops and asks you to solve them manually
- **Passwords:** the agent will never type passwords — it asks you to do it

## 💰 Cost

Free if you have a Claude Code Max / Pro subscription. No API keys needed.

For unlimited high-volume runs, switch Claude Code's model to Haiku in the CLI settings.
