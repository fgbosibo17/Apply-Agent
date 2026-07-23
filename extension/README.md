# Job Apply Agent — Chrome Extension

Fills job applications on company ATS pages, running **inside your real Chrome** —
so it uses your real logins/identity (no bot-detection), can upload your resume from
local disk, and lets you **refine any answer with Claude** before you submit.

This is the hand-apply companion to the Playwright auto-apply bot in `src/`. The bot
runs unattended; this extension is for when *you* apply and just want to skip retyping.

## What it does
- Detects the application form (Greenhouse, Lever, Ashby, Workable — including Greenhouse
  forms embedded via iframe, because the content script runs in all frames).
- Fills name, email, phone, location, links, work-authorization, EEO/demographic fields,
  and screening/essay questions from the selected **persona**.
- Uploads your resume from the local `Resume/` folder via `chrome.debugger`.
- **NEW — AI refine:** after filling, a panel appears listing your free-text answers.
  Type a plain-English instruction on any one — *"make this shorter,"* *"lean into my
  Playwright experience"* — and Claude rewrites just that answer, in place.
- **NEW — shared dedupe:** logs your hand-applies to the same `seen-jobs.csv` /
  `applications-log.csv` the bot uses, so neither tool double-applies to a job.
- "Fill only" leaves the final submit to you (recommended). "Fill + Submit" clicks submit.

## Personas
Three resume tracks across two identities. Fill your own values in `personas.js`
(copied from `personas.example.js`).

| Persona | Identity | Resume |
|---------|----------|--------|
| qa | Identity A | YourName_QA_Resume.pdf |
| cloud | Identity B | YourName_Cloud_Resume.pdf |
| fullstack | Identity B | YourName_FullStack_Resume.pdf |

## One-time setup

### 1. Load the extension
1. Chrome → `chrome://extensions` → toggle **Developer mode** ON (top-right).
2. **Load unpacked** → select this `extension` folder.
3. (Optional) Pin "Job Apply Agent" to the toolbar.
4. Be in the Chrome profile logged into the job boards for the persona you're using.

### 2. Start the refine helper (only needed for the ✨ Refine feature)
The refine feature calls Claude through a tiny local server that uses the **`claude`
CLI — i.e. your existing Claude Code / Anthropic subscription. There is NO API key.**

1. Make sure you're logged into Claude Code: run `claude` once in a terminal; if it
   asks you to authenticate, do so (a one-time thing).
2. From the repo root, start the helper and leave it running while you apply:
   ```
   npm run refine-helper
   ```
   You'll see `Refine helper listening on http://127.0.0.1:8730` and `claude CLI: found ✓`.

Filling and resume upload work **without** the helper — only the ✨ Refine button and the
shared-ledger logging/dedupe need it. If it's not running (or the CLI needs re-auth), the
panel says so and disables refine; everything else still works.

## Use
1. Navigate to a company ATS application page (Greenhouse/Lever/Ashby/Workable).
2. Click the extension icon → pick the **persona** for that job.
   - If the job is already in your shared applied ledger, the popup warns you here.
3. Click **Fill only** (recommended) or **Fill + Submit**.
4. The first time it uploads a resume, Chrome shows a "started debugging this browser"
   banner — that's `chrome.debugger` doing the file upload; leave it.
5. The **✨ Refine answers** panel appears (top-right of the form):
   - Edit any answer directly in its box (writes straight back to the form), or
   - Type an instruction + hit ✨ to have Claude rewrite it.
   - When done, click **✓ Mark applied & log** to record it in the shared ledger,
     then submit the form yourself.

## Notes / limits
- **Resume paths** are absolute local paths in `personas.js` (`RESUME_DIR`, currently a
  macOS path). Edit that constant if the repo moves or you switch machines.
- Model + port are configurable via `REFINE_MODEL` / `REFINE_PORT` env vars (defaults:
  `haiku`, `8730`). `REFINE_MODEL` takes any alias the claude CLI accepts (haiku/sonnet/opus
  or a full id). If you change the port, also update `HELPER` in `background.js`.
- It does NOT auto-submit unless you choose "Fill + Submit". Always glance at the filled
  form before submitting, especially for unusual custom questions.
