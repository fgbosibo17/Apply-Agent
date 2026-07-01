# First Run — Set up your profile, then apply

Use this the **first time** after cloning. It tells the agent to read your resume(s),
build your profile, ask you anything it can't find, and only then start applying —
with the fill→review pipeline so every application is checked before it's submitted.

## Before you paste this

1. Drop your resume(s) into the `Resume/` folder (PDF or DOCX). One per career track
   is fine (e.g. a "Claims" resume and a "Data Entry" resume).
2. Fill in the `<< ... >>` blanks in the block below. **Delete any line that doesn't apply.**
3. Open Claude Code in this folder and paste the whole block (starting at `/goal`).

> ⏱️ The first run can take a while (often ~30 min) — the agent reads your resume,
> builds your profile, asks a few questions, then discovers jobs before the first
> submit. After you've answered its initial questions, you can plug in a **mouse
> jiggler** and let it run.

---

## 📋 Paste this into Claude Code (edit the blanks first)

```
/goal I added my resume(s) to the Resume/ folder. Read them, extract ALL my
information, and build out my profile (fill src/personas.js and the CLAUDE.md
APPLICATION ANSWERS from my resume). Then find REMOTE-ONLY jobs that match and
apply to AT LEAST 50 jobs per resume.

MY INFO (use this; read the rest from my resume):
- Work authorization: << e.g. US citizen; do NOT need current or future sponsorship >>
- Gender: << e.g. Female >>
- Race/ethnicity: << e.g. Black or African American >>  | Hispanic/Latino: << No >>
- Veteran status: << e.g. Not a veteran >>  | Disability: << e.g. No >>
- LinkedIn: << your LinkedIn URL, or write "none" >>
- Location: << City, ST >>  (remote only)
- Salary expectation: << e.g. Open/negotiable, OR a range like $45k–$60k >>
- Highest education: << e.g. High School Diploma / Bachelor's in X / none >>
- Certifications/licenses: << list them, or write "none" >>
- Job roles to apply for: << e.g. Medical Claims Specialist, Data Entry Clerk, Customer Service Rep >>

HARD RULES — do not break these:
1. ASK ME before you start if ANYTHING is unclear or missing. On this FIRST run,
   DO NOT ASSUME — ask me instead. Only start once you have what you need.
2. REVIEW EVERY APPLICATION BEFORE YOU SUBMIT. Use the two-agent fill→review
   pipeline (workflows/fill-review-applications.js): one agent fills from my real
   questions, a second independent agent audits every answer against my resume and
   corrects/rejects before anything is submitted.
3. DO NOT FABRICATE. Genuinely think before answering. Never claim a degree,
   certification, license, skill, language, or years of experience I do not have.
   If I don't have it, the honest answer is "No" / "None" / "0".
4. Use resume blurbs GROUNDED IN MY RESUME for open-ended questions. No invented
   stories, metrics, or achievements that aren't on my resume.
5. DO NOT SUBMIT COVER LETTERS unless a form strictly REQUIRES one to submit.
6. REMOTE ONLY. Skip onsite/hybrid roles and roles that require a credential,
   license, or language I don't have.
7. Log everything and never apply to the same job twice.

When my profile is built and you've confirmed my answers with me, start applying.
```

---

## What the agent will do

1. Read your resume(s) and fill `src/personas.js` + the `CLAUDE.md` profile.
2. Ask you a short list of questions for anything not on the resume — **answer these**.
3. Discover fresh remote jobs that match your target roles.
4. For each job: **fill agent** drafts answers from the real questions → **review agent**
   audits them against your resume → only vetted, approved jobs get submitted.
5. Log each application (`applications-log.csv`) and never repeat one (`seen-jobs.csv`).

## Tips

- Answer the agent's first-run questions carefully — everything after builds on them.
- Keep the browser window it opens visible; a **mouse jiggler** prevents your machine
  from sleeping during the long unattended stretch.
- Once setup is done, use [`prompts/02-subsequent-runs.md`](02-subsequent-runs.md) for
  every run after this one — it skips setup and just applies to more jobs.
