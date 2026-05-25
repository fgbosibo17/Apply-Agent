# 🚀 Job Agent — Getting Started

A fully autonomous AI job-application agent. You drop in your resume, run two commands, and it applies to dozens of jobs for you — searching LinkedIn, Indeed, Greenhouse, Lever, Workday, Ashby, and 20+ other ATS platforms on autopilot.

This guide takes you from zero → running in about **15 minutes**.

---

## What you need first

- A computer (Windows, macOS, or Linux) with **~2 GB of free disk space** and an **internet connection**
- An **email address** you want on your job applications
- Your **resume** as PDF or DOCX
- A **LinkedIn account** (free is fine)
- A **credit card** for the Claude subscription

You will also need three pieces of software installed: **Git**, **Node.js**, and **Claude Desktop**. Step 1 below covers all three. If you already have any of them, you can skip ahead.

---

## Step 1 — Install the three tools you need

You only do this once per computer. **Pick your OS section** and follow it top to bottom.

### 🪟 Windows

**A. Install Git**
1. Go to **https://git-scm.com/download/win**
2. The download starts automatically. Run the installer.
3. Click **Next** through every screen with the defaults — they're fine.
4. When done, restart any open PowerShell/Terminal windows.

**B. Install Node.js (which includes npm)**
1. Go to **https://nodejs.org**
2. Download the **LTS** version (the green button on the left).
3. Run the installer. Click Next through every screen with defaults.
4. **Important:** make sure the checkbox "Automatically install the necessary tools..." stays checked.
5. Restart any open PowerShell windows.

**C. Install Claude Desktop**
1. Go to **https://claude.ai/download**
2. Download the Windows installer and run it.
3. Sign in (or create a Claude account — free for now, you'll subscribe in Step 2).

**D. Verify everything works**
Open **PowerShell** (press `Windows key` → type `PowerShell` → Enter) and run these one at a time:
```powershell
git --version
node --version
npm --version
```
You should see a version number after each one (e.g. `git version 2.43.0`). If any says **"is not recognized"**, close PowerShell, open a fresh one, and try again. If it still fails, restart your computer — PATH changes need a reboot sometimes.

---

### 🍎 macOS

**A. Install Git** (comes with Apple's Command Line Tools)

Open **Terminal** (press `Cmd+Space` → type `Terminal` → Enter) and run:
```bash
xcode-select --install
```
A popup appears. Click **Install** and wait ~5 minutes.

**B. Install Node.js (which includes npm)**

The easiest way:
1. Go to **https://nodejs.org**
2. Download the **LTS** installer for macOS (the green button).
3. Run the `.pkg` file. Click Continue through every screen.

(If you already have Homebrew, you can run `brew install node` instead.)

**C. Install Claude Desktop**
1. Go to **https://claude.ai/download**
2. Download the macOS version (`.dmg`).
3. Open the `.dmg` and **drag Claude into your Applications folder**.
4. Open Claude from Applications. If macOS says "Claude can't be opened because it is from an unidentified developer," go to **System Settings → Privacy & Security**, scroll to the bottom, and click **Open Anyway**.
5. Sign in (or create a free Claude account — you'll subscribe in Step 2).

**D. Verify everything works**

In Terminal, run:
```bash
git --version
node --version
npm --version
```
All three should print version numbers. If any says **"command not found"**, close Terminal, reopen it, and try again.

---

### 🐧 Linux (Ubuntu / Debian-based)

Open a terminal and run:
```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

For **Claude Desktop** on Linux: download from **https://claude.ai/download** (currently provided as an AppImage or .deb depending on availability). If a desktop build isn't available for your distro, you can use the [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) directly in your terminal — the agent works either way.

Verify:
```bash
git --version
node --version
npm --version
```

---

## Step 2 — Sign up for Claude Pro or Max

The agent runs on Anthropic's Claude AI. The free tier won't cut it — you need a paid plan for the model quality + usage limits.

1. Inside **Claude Desktop** (or at **https://claude.ai**), click your **profile icon → Settings → Billing**
2. Pick a plan:
   - **Pro** (~$20/mo) — fine for most people, ~20–40 applications per day
   - **Max** (~$100–200/mo) — for power users running multiple long sessions daily
3. Complete checkout with your credit card

> 💡 **Start with Pro.** You can upgrade to Max later if you hit usage limits.

---

## Step 3 — Clone the repo

Pick a folder where you keep code projects (your Desktop works fine for a first run).

**Windows:** open PowerShell. **Mac/Linux:** open Terminal.

Then run:
```bash
cd Desktop
git clone https://github.com/fgbosibo17/Apply-Agent.git job-agent
cd job-agent
```

If `git clone` asks for credentials, sign in with your GitHub account in the popup. If you don't have one, create a free account at **https://github.com/signup** first.

---

## Step 4 — Open the project in Claude Code

Claude Desktop has a built-in **Code** section that lets Claude work directly inside a project folder. That's where the agent lives.

1. Open **Claude Desktop**
2. In the left sidebar, click **Code** (the `</>` icon)
3. Click **Open project** (or **Add project**)
4. Browse to the `job-agent` folder you cloned in Step 3 and select it
5. You're now inside Claude Code with the project loaded — there's a chat box at the bottom

---

## Step 5 — Install the browser dependencies

In the Claude Code chat box, paste this prompt:

```
Install the project dependencies — run npm install and confirm Playwright
is set up so the agent can drive a real browser.
```

Claude will run `npm install` for you — this downloads Playwright (the browser automation library the agent uses) and takes ~1–2 minutes. You only do this once.

---

## Step 6 — Drop your resume in

Inside the `job-agent` folder, there's a `Resume/` subfolder. Drop your resume PDF or DOCX into it. **Any filename is fine.**

```
job-agent/
├── Resume/
│   └── MyResume.pdf      ← drop your file here
├── CLAUDE.md
└── ...
```

---

## Step 7 — Tell Claude to read your resume and fill out the application answers

Paste this prompt into the Claude Code chat box:

```
Read my resume from the Resume folder and fill out the application
answers in CLAUDE.md. Ask me whatever isn't on my resume —
work authorization, salary range, location preference, EEO info,
contract openness, and a 1-2 sentence "why this kind of role" blurb.
Show me a summary at the end so I can confirm.
```

Claude will:

1. **Find** your resume in the `Resume/` folder
2. **Read** it — pulls name, email, phone, LinkedIn, current job, skills, education
3. **Auto-fill** the `📝 APPLICATION ANSWERS` block in `CLAUDE.md`
4. **Ask you 6–7 quick questions** that resumes don't cover:
   - Work authorization (US citizen, green card, visa, etc.)
   - Target salary range
   - Remote / hybrid / onsite preference
   - EEO answers (gender, race, veteran status) — you can say **"Prefer not to say"** to any
   - Open to contract work?
   - 1–2 sentences on why you want this kind of role
5. **Show you a summary** — type `yes` to save, or tell it what to fix

> 💡 **Shortcut:** You can also just type `setup` — it triggers the exact same workflow. The longer prompt above just spells out what's happening so you know what to expect.

---

## Step 8 — Tell Claude to set up the browser profile (LinkedIn login)

This step saves a logged-in LinkedIn session so the agent doesn't have to interrupt every job-search session asking you to sign in. You do it **once.**

Paste this prompt:

```
Set up the browser profile now. Open Chrome with the persistent profile,
walk me through logging into LinkedIn (I'll type my password myself —
do not touch the password field), and optionally Google after that.
Confirm once the session is saved.
```

Claude will:

1. Open a real **Chrome window** pointed at LinkedIn's login page
2. **Stop and wait** for you to sign in — **you type your password yourself**, Claude will not touch it
3. Once you say you're logged in, ask if you want to also log into **Google** (useful for "Sign in with Google" buttons on ATS sites like Workday, iCIMS, SmartRecruiters) — say `yes` or `skip`
4. **Save the session** in a folder called `browser-profile/` in the project — persists forever, so you only do this once
5. Confirm you're ready to apply

> 🔐 **Password safety:** Claude **never** sees, types, generates, or stores any password. You enter every credential directly into the browser window yourself. The only thing saved on your machine is the browser's session cookies.

> 💡 If you already ran `setup` in Step 7, the browser-profile step is automatically included there — you can skip Step 8.

---

## Step 9 — Tell Claude to start applying

Paste this prompt:

```
go
```

That's it — one word. The agent starts:

- 🔍 **Searching** 25+ job boards for matches against your profile
- 📂 **Opening** matching listings on the company's actual ATS page (Greenhouse, Lever, Workday, Ashby, iCIMS, etc.)
- ✍️ **Filling** forms using the answers from your setup
- 📎 **Uploading** your resume
- 💌 **Generating** tailored cover letters (when required)
- 📬 **Submitting** applications

**Default goal:** 40 successful applications per session. You can change `SESSION_TARGET` in `CLAUDE.md` to whatever you want.

You can leave it running while you do other things. Every job is logged in `applications-log.csv` so it never applies twice.

---

## ❓ Common questions

**Will it apply to jobs I don't want?**
No. It scores each listing against your profile and skips anything below the match-score threshold. You can also set a salary floor and location filters.

**Is my password safe?**
Yes. The agent never sees, types, or stores any password. You log in yourself in the browser window. Sessions are saved as cookies on your local machine.

**What if I want to stop mid-session?**
Close Claude Code or type `stop`. Your progress is saved automatically — next time you say `go`, it picks up where it left off.

**Can I run it daily without opening Claude Code?**
Yes. There's an `install-schedule.bat` for Windows that sets up a daily run via Task Scheduler. Mac/Linux users can use cron.

**Does it work for non-tech jobs?**
Yes, but it's currently optimized for tech (skills detection, ATS coverage). Sales, marketing, ops, and design roles work fine on most common ATS platforms.

---

## 🛟 If something breaks

### Setup-time problems

| Problem | Fix |
|---|---|
| `git: command not found` / "is not recognized" | Git didn't install or PATH didn't refresh. Close every terminal/PowerShell window and open a new one. If still failing, restart your computer. |
| `node: command not found` / `npm: command not found` | Same — restart your terminal first, then reboot if it persists. Verify with `node --version`. |
| `git clone` asks for username/password | Sign into your GitHub account in the popup. If you don't have one, create one at https://github.com/signup, then re-run the clone. |
| Claude Desktop won't open on Mac ("unidentified developer") | System Settings → Privacy & Security → scroll down → **Open Anyway** |
| Windows SmartScreen blocks an installer | Click **More info → Run anyway**. These installers are signed but Windows is cautious with fresh downloads. |
| `npm install` errors about Python or build tools | Re-run the Node.js installer with the "Automatically install the necessary tools" checkbox ticked. Reboot, then retry. |
| Claude Code doesn't see the `job-agent` folder | Make sure you actually `cd`'d into it during the clone step. The folder should contain `CLAUDE.md` and `package.json` at the top level. |

### Run-time problems (during application sessions)

| Problem | Fix |
|---|---|
| "Can't find my resume" | Make sure it's in the `Resume/` subfolder, not the project root. Filename can be anything but must be `.pdf` or `.docx`. |
| "LinkedIn won't log in" | Log into LinkedIn manually in the agent's browser window, then tell Claude `continue` |
| "Stuck on a form" | Say `skip this one` — it logs the issue and moves on |
| Hit Claude usage limit mid-session | Wait for your quota to reset (Pro: ~5 hours, Max: longer windows), or upgrade. Progress is saved — `go` resumes where it left off. |
| Anything weird | Take a screenshot of what you see and paste it in the chat. Claude can read images and figure out what to do. |

---

## 🎯 Daily flow (after setup)

1. Open Claude Desktop → click **Code** → open the `job-agent` project
2. Type `go`
3. Walk away
4. Check `applications-log.csv` later to see what was applied to

That's it. Good luck out there. 🍀
