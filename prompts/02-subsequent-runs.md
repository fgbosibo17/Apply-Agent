# Subsequent Runs — Keep applying

Use this **after your profile is already set up** (i.e. you've run
[`01-first-run.md`](01-first-run.md) once). It skips setup and just discovers more
remote jobs and applies to them, with the same review-before-submit guardrails.

## Before you paste this

- Your profile is already in `src/personas.js` / `CLAUDE.md` — no need to re-enter it.
- Optionally change `<< N >>` (how many more to apply to) and which resume/persona.
- Paste the whole block (starting at `/goal`) into Claude Code in this folder.

> The agent already knows your info, so it won't re-ask setup questions. It dedupes
> against `seen-jobs.csv`, so it never re-applies to jobs you've already seen.

---

> ℹ️ Claude Code's `/goal` accepts up to ~4000 characters. This block is ~1,400, so
> you have plenty of room to tweak it.

## 📋 Paste this into Claude Code

```
/goal My profile is already set up. Discover MORE remote-only jobs that match my
target roles and apply to at least << N >> more per resume, continuing from where I
left off (dedupe against seen-jobs.csv — never re-apply to a job I've already seen).

HARD RULES — do not break these:
1. REVIEW EVERY APPLICATION BEFORE YOU SUBMIT. Use the two-agent fill→review
   pipeline (workflows/fill-review-applications.js): one agent fills from the real
   questions, a second independent agent audits every answer against my resume and
   corrects/rejects before anything is submitted.
2. DO NOT FABRICATE. Genuinely think before answering. Never claim a degree,
   certification, license, skill, language, or years of experience I do not have.
   If I don't have it, the honest answer is "No" / "None" / "0".
3. Use resume blurbs GROUNDED IN MY RESUME for open-ended questions. No invented
   stories, metrics, or achievements.
4. DO NOT SUBMIT COVER LETTERS unless a form strictly REQUIRES one to submit.
5. REMOTE ONLY. Skip onsite/hybrid roles and roles that require a credential,
   license, or language I don't have — the review agent should reject those.
6. Don't re-ask my setup info — it's already in src/personas.js and CLAUDE.md.
   Only ask me if something genuinely new comes up.

Report how many you submitted per resume when you're done.
```

---

## Handy variations (paste instead, or add to the goal)

- **One resume only:** `... apply to at least << N >> more jobs for my << primary/adjacent >> resume only ...`
- **Refresh the job pool first:** add `First run discovery to pull fresh listings, then apply.`
- **A quick top-up:** set `<< N >>` low (e.g. 10) for a short session.

## Tips

- Keep the browser window visible; use a **mouse jiggler** for long unattended runs.
- If a run stalls on one ATS (e.g. reCAPTCHA), tell the agent to prioritize
  Greenhouse jobs — that's where the fill→review pipeline works end-to-end.
- Review `applications-log.csv` anytime to see everywhere you've applied.
