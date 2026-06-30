# Batch job application runner

Auto-applies to jobs across **Greenhouse / Lever / Ashby / Workable** using the form patterns derived from the Claude-driven session on 2026-05-26.

## How to run

```powershell
# from project root
node src/index.js
```

Optional env overrides:
- `SESSION_TARGET=10 node src/index.js` — stop after 10 successful submissions
- `MAX_EVALUATED=50 node src/index.js` — stop after 50 jobs evaluated (safety cap)

The runner:
1. Reads `queue.json` (top-level array of `{url, company, role, source, matchScore}` objects)
2. Loads `seen-jobs.csv` to skip already-evaluated URLs
3. Detects the ATS by URL and dispatches to `src/ats/<platform>.js`
4. For each job:
   - Pre-flight checks job description for non-US locations / clearance requirements
   - Skips if it has long-form essay questions (manual completion needed)
   - Fills standard fields from `src/answers.js`
   - Submits and waits for confirmation page
   - Appends result to `applications-log.csv` (if Applied) + `seen-jobs.csv` (always)
5. Reports a summary at the end

## What it handles automatically

| ATS | Resume upload | Standard fields | Yes/No work-auth | EEO demographics | Long-form essays |
|---|---|---|---|---|---|
| Greenhouse | ✓ | ✓ | ✓ (React-Select) | partial | **skip** |
| Lever | ✓ | ✓ | ✓ | ✓ (selects) | **skip** |
| Ashby | ✓ (autofill) | ✓ | ✓ (button-style) | ✓ (radio labels) | **skip** |
| Workable | ✓ | ✓ | ✓ (radios) | partial | **skip** |
| Workday | — | — | — | — | **skip** (account/password) |
| iCIMS / Taleo | — | — | — | — | **skip** (account/password) |

## What it does NOT do

- Open-ended essay questions (4+ paragraph answers) — flagged and skipped, do these manually
- Workday / iCIMS / Taleo account creation (would require your password)
- CAPTCHAs — will likely error out, skip and retry manually
- LinkedIn / Indeed discovery (separate script needed)
- Compensation-required-pick comboboxes (like Super.com's broken widget)

## Updating answers

Edit `src/answers.js`. All form fills read from this single module.

## Adding new ATS

Drop a new file in `src/ats/<name>.js` exporting an `apply<Name>` function with the same signature:
```js
async function applyMyAts(page, jobMeta) { return { status: 'Applied'|'Skipped'|'Error', reason: '...' }; }
```
Then add it to the `detectAts` URL regex and dispatch in `src/index.js`.
