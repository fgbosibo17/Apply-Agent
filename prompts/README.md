# Ready-to-use prompts

Copy-paste prompt templates for driving this agent with [Claude Code](https://claude.com/claude-code).
They use the `/goal` command so the agent keeps working until the goal is met, and they
bake in the guardrails that keep applications accurate and honest.

| Prompt | When to use |
|--------|-------------|
| [`01-first-run.md`](01-first-run.md) | **First time** after cloning — reads your resume, builds your profile, asks questions, then applies. |
| [`02-subsequent-runs.md`](02-subsequent-runs.md) | **Every run after** — skips setup, discovers more jobs, applies to more. |

## How to use

1. **Clone the repo** and run `npm install` (and `npx playwright install chrome`).
2. **Drop your resume(s)** into the `Resume/` folder (one per career track is fine).
3. Open **`prompts/01-first-run.md`**, fill in the `<< ... >>` blanks with your info,
   delete lines that don't apply, and **paste the whole `/goal` block into Claude Code.**
4. Answer the questions it asks on the first run (it won't assume — it asks).
5. Let it run. First run can take ~30 min before the first submit; a **mouse jiggler**
   keeps your machine awake for the unattended stretch.
6. Next time, use **`prompts/02-subsequent-runs.md`** to keep applying.

## The guardrails (why the applications come out clean)

Both prompts enforce the same rules — change the wording to fit you, but keep the intent:

- **Review before submit** — a two-agent fill→review pipeline checks every answer against
  your resume before anything is sent (see the repo README).
- **No fabrication** — never claims a degree, certification, license, skill, language, or
  years of experience you don't have.
- **Resume-grounded answers** — open-ended questions use blurbs tied to your real resume,
  no invented stories or metrics.
- **No unsolicited cover letters** — only attached when a form strictly requires one.
- **Remote only** — onsite/hybrid and credential-gated roles are skipped.

## Make it yours

Everything is a template. Edit `src/personas.js` and the `CLAUDE.md` profile directly, or
just change the `<< ... >>` fields in the prompt. You can also write your own `/goal`
prompts — the two here are a starting point, not a limit.

> **Keep `/goal` under ~4000 characters.** Claude Code caps the `/goal` command at about
> 4000 chars. The first-run block is ~2,200 and the subsequent-runs block is ~1,400, so
> you have room — but keep fill-ins short. Anything longer (extra detail, notes) belongs in
> your resume or `src/personas.js`, not the goal.
