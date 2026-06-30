# Job Application Agent — Instructions & Applicant Profile

---

## 🚀 FIRST-TIME SETUP (if you're new here, read this)

**If APPLICATION ANSWERS below still has `<FILL_ME_IN>` placeholders, this project hasn't been set up for you yet.** Do this once:

1. Drop your resume into the `Resume/` subfolder of this project. Any filename is fine — PDF or DOCX. Examples: `Resume/MyResume.pdf`, `Resume/JaneDoe_Resume.pdf`. (Dropping it in the project root also works as a fallback — the setup wizard checks `Resume/` first, then the root.)
2. Open Claude Code in this folder (`claude` in the terminal).
3. Say: **`setup`** (or `initialize me`, `bootstrap my profile`, etc.).
4. The agent will:
   - Read your resume
   - Fill out the REQUIRED fields in `📝 APPLICATION ANSWERS` below from your resume
   - Ask you a short list of questions for things not in the resume (salary expectations, demographics for EEO, work auth status, citizenship, etc.)
   - Save everything back into this file
   - **Open a browser and walk you through logging into LinkedIn** (and optionally Google for ATS OAuth) — the session is saved in `./browser-profile-primary` so you only do this once
   - Confirm with you before going live
5. Once setup is done, say **`go`** to start the job application workflow.

You can re-run `setup` any time to refresh your profile from a new resume.

> **Agent: when the user invokes "setup" / "initialize" / "bootstrap me" — follow the SETUP WIZARD instructions in the section near the end of this file.**

---

## ⚙️ SESSION CONFIG (edit these values to change agent behavior)

> **Quick edits the user makes here override every other default in this file. The agent MUST read this block at session start and obey it for the rest of the run.**

```yaml
# How many applications must be SUCCESSFULLY SUBMITTED per session before stopping.
# Only counts apps that hit a confirmation page / "Application received" state.
# Errors, CAPTCHAs, closed listings, and skipped jobs do NOT count toward this.
# Increase for marathon runs (e.g. 50, 100). Decrease for a quick burst (e.g. 5).
SESSION_TARGET: 40

# Hard cap on listings the agent will OPEN and evaluate per session
# (skipped jobs still count against this). Prevents runaway browsing.
# Set to 0 to disable the cap.
MAX_JOBS_EVALUATED: 200

# Minimum match score (out of 10) required to apply. Lower = more applications,
# less selective. Higher = fewer applications, only strong matches.
MIN_MATCH_SCORE: 7

# Salary floor in USD. Jobs that publicly list below this are skipped.
# Jobs with no salary published are still considered.
MIN_SALARY: 95000

# Comma-separated location filters. "Remote-US" = US-remote roles only.
# Add "Hybrid-<City>" to allow hybrid roles in a specific city.
LOCATIONS_OK: Remote-US, Hybrid-<City> (1-2 days/week)

# Whether the agent should ASK before each application or apply silently.
# "auto" = apply without asking. "confirm" = show the match and wait for "go".
APPLY_MODE: auto

# Channels to skip this session (comma-separated). Useful when one is rate-limiting
# you or you've already exhausted it. Leave blank to use all.
SKIP_CHANNELS:

# Channels to prioritize first this session. Leave blank to round-robin Tier 1 → 4.
# PRIMARY = the logged-in job boards (richer, fresher, better-matched results
# because we're authenticated). These are the default discovery surface going
# forward. Each still requires clicking through to the company ATS to apply.
PRIORITY_CHANNELS: linkedin, builtin, wellfound, workatastartup, welcometothejungle, dice, ziprecruiter, indeed

# Logged-in boards available per identity (both profiles signed in):
#   linkedin, builtin, wellfound, workatastartup, welcometothejungle,
#   dice, ziprecruiter, indeed (same account covers simplyhired)
# Aggregators (no login — click through to company ATS): nodesk, workingnomads
# Google site: searches (greenhouse/lever/ashby/workable) remain a SECONDARY
# fallback when the logged-in boards run dry for a query.
LOGGED_IN_BOARDS: linkedin, builtin, wellfound, workatastartup, welcometothejungle, dice, ziprecruiter, indeed
```

> **⚠️ APPLY STRATEGY — EXTERNAL ATS ONLY (decided 2026-06-11).**
> Boards are for **discovery**; applications are submitted **only on external company
> ATSs** (Greenhouse, Lever, Ashby, Workable, etc.) where our handlers work reliably.
> **Do NOT automate LinkedIn Easy Apply** (or ZipRecruiter/Indeed 1-click): LinkedIn's
> current build blocks automated Easy Apply (obfuscated DOM, modal won't open for bots)
> and automating it **risks getting the user's LinkedIn account banned**. Easy-Apply-only
> listings are logged `Skipped` (reason: "Easy Apply only - external-ATS-only mode").
> `src/ats/linkedin-easyapply.js` exists but is intentionally NOT wired into the runner.

**How the agent uses this config:**
1. At session start, the agent reads this block and uses these values for the entire session.
2. `SESSION_TARGET` is the *primary* stop condition — once that many applications are SUCCESSFULLY SUBMITTED (logged as `Applied` in `applications-log.csv` after reaching a confirmation page), the agent stops and reports. Anything logged as `Skipped`, `Error`, `Closed`, or `Duplicate` does NOT count toward the target — keep going until 40 real submissions land.
3. `MAX_JOBS_EVALUATED` is the *safety* stop condition — if the agent burns through this many listings without hitting `SESSION_TARGET`, it stops anyway and reports the low hit rate.
4. If the user says e.g. "apply to 50 jobs today" in the prompt, that overrides `SESSION_TARGET` for that run.
5. `MIN_MATCH_SCORE`, `MIN_SALARY`, `LOCATIONS_OK` are filters applied during evaluation — a job that fails any of them is logged as Skipped without opening the application page.

---

## 🎭 PERSONAS (3 resumes, 2 identities — READ THIS BEFORE APPLYING)

> The agent applies as **three personas across two identities**. Persona definitions (full answer sets) live in `src/personas.js`. Select with the `PERSONA` env var when running batch scripts (`qa` | `cloud` | `fullstack`). **There is NO default persona — every run must state one explicitly, and the agent must ASK THE USER which persona(s) to run when the user hasn't said.** Same for manual MCP applications: before applying, confirm which persona the job belongs to.

| Persona | Identity | Email | Phone | LinkedIn | Resume | Browser profile |
|---------|----------|-------|-------|----------|--------|-----------------|
| **primary** | <Your Full Name> | you@example.com | +1 000-000-0000 | linkedin.com/in/your-handle | `Resume/Your_Resume_A.pdf` | `./browser-profile-primary` |
| **adjacent** | <Your Full Name> | you2@example.com | +1 000-000-0000 | linkedin.com/in/your-handle-2 | `Resume/Your_Resume_B.pdf` | `./browser-profile-secondary` |
| **secondary** | <Your Full Name> | you2@example.com | +1 000-000-0000 | linkedin.com/in/your-handle-2 | `Resume/Your_Resume_C.pdf` | `./browser-profile-secondary` |

**Hard rules:**
1. **Never mix identities on one application.** Resume header, form answers, and the logged-in job-board account must ALL match the persona. Cloud + FullStack share accounts/logins; QA is fully separate.
2. **Route jobs by JD:** QA/SDET/testing keywords → `qa`. Cloud/DevOps/SRE/platform → `cloud`. Full-stack/frontend/backend/software engineer → `fullstack`. Router: `routePersona()` in `src/personas.js`.
3. **Per-persona dedupe:** the same job may be applied to by ONLY ONE persona — never apply twice to one job with different identities.
4. **Browser profiles:** re-run logins with `node setup-browser-login.js primary` or `node setup-browser-login.js secondary`. Both identities have accounts on: LinkedIn, Builtin, Wellfound, WorkAtAStartup, WelcomeToTheJungle, Dice, ZipRecruiter, Indeed (same account covers SimplyHired). NoDesk + WorkingNomads are aggregators — no login, click through to the company ATS.
5. The `📝 APPLICATION ANSWERS` block below remains the source of truth for the **qa** persona only. Cloud/FullStack values live in `src/personas.js`.

---

## 📝 APPLICATION ANSWERS (edit these to change what the agent fills into forms)

> **This block is the SINGLE SOURCE OF TRUTH for every form field the agent fills.** When a job application asks for a value, the agent reads it from here first. If a field isn't covered here, it falls back to the "Standard Answers" table further down. A user edit here always wins.

```yaml
# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║                                                                           ║
# ║   ✅ REQUIRED FIELDS                                                       ║
# ║                                                                           ║
# ║   The agent NEEDS these to fill any application. Every field here must    ║
# ║   have a value — leaving any blank will BLOCK applications that ask for   ║
# ║   that data. Run the SETUP WIZARD to auto-populate from your resume.      ║
# ║                                                                           ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

# ─── IDENTITY (required) ────────────────────────────────────────────────────
FIRST_NAME: <First>
LAST_NAME: <Last>
FULL_NAME: <Your Full Name>
EMAIL: you@example.com
PHONE_COUNTRY_CODE: "+1"            # always quote so leading + is kept
PHONE_NUMBER: "0000000000"          # digits-only form
PHONE_FULL: "+1 000-000-0000"       # e.g. "+1 555-123-4567"

# ─── LOCATION (required) ────────────────────────────────────────────────────
CITY: <City>
STATE: <ST>                           # 2-letter code, e.g. CA, <ST>, NY
COUNTRY: United States
COUNTRY_CODE: US
FULL_ADDRESS_ONE_LINE: "<City, ST>, United States"

# ─── LINKS (required) ───────────────────────────────────────────────────────
LINKEDIN_URL: https://www.linkedin.com/in/your-handle/

# ─── WORK AUTHORIZATION (required) ──────────────────────────────────────────
AUTHORIZED_TO_WORK_US: "Yes"
NEED_SPONSORSHIP_NOW: "No"
NEED_SPONSORSHIP_FUTURE: "No"
US_CITIZEN: "No"
WORK_AUTH_STATUS: Green Card / Permanent Resident

# ─── SALARY EXPECTATIONS (required) ─────────────────────────────────────────
SALARY_MIN: 95000
SALARY_MAX: 130000
SALARY_TARGET_SINGLE: 115000
SALARY_RANGE_STRING: "$100,000 - $130,000"

# ─── START DATE / AVAILABILITY (required) ───────────────────────────────────
NOTICE_PERIOD: 2 weeks
EARLIEST_START_DATE: 2 weeks from offer acceptance

# ─── WORK PREFERENCES (required) ────────────────────────────────────────────
PREFERRED_WORK_TYPE: Remote
OPEN_TO_HYBRID: "Yes"
OPEN_TO_ONSITE: "No"
WILLING_TO_RELOCATE: "No"

# ─── BACKGROUND / CONSENT (required) ────────────────────────────────────────
CONSENT_BACKGROUND_CHECK: "Yes"
CONSENT_DRUG_TEST: "Yes"
HAS_NON_COMPETE: "No"
IS_18_OR_OLDER: "Yes"
WORKED_HERE_BEFORE: "No"

# ─── REFERRAL / DISCOVERY (required) ────────────────────────────────────────
HOW_DID_YOU_HEAR: LinkedIn

# ─── EEO / DEMOGRAPHICS (required on most US apps) ──────────────────────────
GENDER: <Male | Female | Non-binary | Prefer not to say>
ETHNICITY: <e.g. Asian | Black or African American | Hispanic or Latino | White | Two or more races | Prefer not to say>
RACE: <e.g. Asian | Black or African American | Hispanic or Latino | White | Two or more races | Prefer not to say>
HISPANIC_LATINO: "No"
VETERAN_STATUS: I am not a protected veteran
DISABILITY_STATUS: No, I do not have a disability

# ─── EMPLOYMENT STATUS (required) ───────────────────────────────────────────
CURRENTLY_EMPLOYED: "Yes"
EMPLOYMENT_STATUS: "Full-time, employed"
REASON_FOR_LEAVING: "<1 sentence — why you are looking for a new role>"
CAN_CONTACT_CURRENT_EMPLOYER: "No"  # almost always "No" until offer stage

# ─── ENGAGEMENT TYPE (required) ─────────────────────────────────────────────
OPEN_TO_FULL_TIME: "Yes"
OPEN_TO_CONTRACT: "Yes"

# ─── ROLE BLURB (required — used in open-text "tell us about you" fields) ───
WHY_THIS_ROLE_BLURB: "<2-3 sentences for open-ended 'why this role' fields — your motivation plus your top strengths>"
ELEVATOR_PITCH: "<1 sentence: who you are + your specialty + years of experience>"

# ─── ATTESTATIONS (required — every form has these checkboxes) ──────────────
CERTIFY_TRUTHFUL_ANSWERS: "Yes"
AGREE_TO_TERMS: "Yes"
AGREE_TO_PRIVACY_POLICY: "Yes"

# ─── EDUCATION (required) ───────────────────────────────────────────────────
HIGHEST_DEGREE: Master's Degree
HIGHEST_DEGREE_FIELD: <Your Field of Study>
HIGHEST_DEGREE_SCHOOL: <Your University>
UNDERGRAD_DEGREE: Bachelor's Degree
UNDERGRAD_FIELD: Computer Science
UNDERGRAD_SCHOOL: <Your University>

# ─── CURRENT JOB (required) ─────────────────────────────────────────────────
CURRENT_EMPLOYER: <Current Employer>
CURRENT_TITLE: <Your Current Title>
TOTAL_YEARS_EXPERIENCE: 9

# ─── RESUME (required) ──────────────────────────────────────────────────────
RESUME_FILE: Resume/Your_Resume_A.pdf

# ─── COVER LETTER (required toggle) ─────────────────────────────────────────
COVER_LETTER_ENABLED: true
COVER_LETTER_TONE: "concise, confident, professional"
COVER_LETTER_LENGTH: 3-4 sentences


# ╔═══════════════════════════════════════════════════════════════════════════╗
# ║                                                                           ║
# ║   ⚪ OPTIONAL FIELDS                                                       ║
# ║                                                                           ║
# ║   You DON'T have to fill any of these. If a form asks for an optional     ║
# ║   field and the value below is blank, the agent will INFER a reasonable   ║
# ║   answer from the REQUIRED fields above + the resume + the job            ║
# ║   description, instead of skipping or asking you.                         ║
# ║                                                                           ║
# ║   Only fill an optional value if you want to LOCK IN a specific answer.   ║
# ║   A filled value always beats the inference.                              ║
# ║                                                                           ║
# ╚═══════════════════════════════════════════════════════════════════════════╝

# ─── IDENTITY EXTRAS (optional) ─────────────────────────────────────────────
PREFERRED_NAME:                     # what forms should call you
PRONOUNS:                           # e.g. "He/Him", "She/Her", "They/Them"
DATE_OF_BIRTH:                      # leave blank — never give DOB unless legally required

# ─── LOCATION EXTRAS (optional) ─────────────────────────────────────────────
STATE_FULL: <State>
ZIP:                                # quoted if leading zero
ADDRESS_LINE_1:
ADDRESS_LINE_2:
TIMEZONE: <Your/Timezone>

# ─── LINKS (optional) ───────────────────────────────────────────────────────
PORTFOLIO_URL:                      # falls back to LINKEDIN_URL if blank
GITHUB_URL:
PERSONAL_WEBSITE:
TWITTER_X_URL:
OTHER_URL:

# ─── WORK AUTHORIZATION EXTRAS (optional) ───────────────────────────────────
VISA_TYPE:
WORK_AUTH_LONG_FORM:                # paragraph-style explanation if needed

# ─── SECURITY CLEARANCE (optional — only asked by gov / defense roles) ──────
HAS_SECURITY_CLEARANCE: "No"
WILLING_TO_GET_CLEARANCE: "Yes"
CLEARANCE_TYPE:

# ─── SALARY EXTRAS (optional) ───────────────────────────────────────────────
SALARY_HOURLY:                      # USD/hr equivalent
SALARY_CURRENCY: USD
SALARY_NEGOTIABLE: "Yes"

# ─── COMPENSATION EXTRAS (optional) ─────────────────────────────────────────
CURRENT_SALARY:                     # leave blank — illegal to ask in many states
DESIRED_SIGN_ON_BONUS: Open to discussion
EQUITY_EXPECTATION: Open to standard equity package commensurate with level
HAVE_OTHER_OFFERS: "Currently interviewing with several companies"
TOTAL_COMP_LAST_YEAR:               # leave blank unless forced
PAY_FREQUENCY_PREFERENCE: Bi-weekly
PTO_EXPECTATION: "Standard PTO (15-20 days) plus company holidays"

# ─── START DATE EXTRAS (optional) ───────────────────────────────────────────
EARLIEST_START_DATE_SHORT: 2 weeks
AVAILABILITY_TEXT: "Available to start within 2 weeks of offer acceptance."
HOURS_PER_WEEK: 40
WILLING_TO_WORK_WEEKENDS: "No"
WILLING_TO_WORK_OVERTIME: "Yes, when needed for project delivery"

# ─── WORK PREFERENCE EXTRAS (optional) ──────────────────────────────────────
RELOCATION_ASSISTANCE_NEEDED: "Yes"
WILLING_TO_TRAVEL: "Yes, up to 25%"

# ─── BACKGROUND EXTRAS (optional) ───────────────────────────────────────────
PREVIOUSLY_APPLIED: "No"
CONVICTED_FELONY: "No"

# ─── REFERRAL (optional) ────────────────────────────────────────────────────
REFERRAL_NAME:                      # fill if a current employee referred you
REFERRAL_EMAIL:

# ─── EEO EXTRAS (optional self-id) ──────────────────────────────────────────
LGBTQ_STATUS: Prefer not to say
TRANSGENDER:                        # blank or "No" / "Yes" / "Prefer not to say"

# ─── ETHNICITY MULTI-SELECT (optional — for forms that list each option) ────
ETHNICITY_WHITE:
ETHNICITY_BLACK_AFRICAN_AMERICAN:
ETHNICITY_ASIAN:
ETHNICITY_HISPANIC_LATINO:
ETHNICITY_NATIVE_AMERICAN:
ETHNICITY_PACIFIC_ISLANDER:
ETHNICITY_TWO_OR_MORE:
ETHNICITY_DECLINE:

# ─── ENGAGEMENT TYPE EXTRAS (optional) ──────────────────────────────────────
OPEN_TO_CONTRACT_TO_HIRE: "Yes"
OPEN_TO_PART_TIME: "No"
OPEN_TO_W2: "Yes"
OPEN_TO_1099:
OPEN_TO_C2C:
OPEN_TO_INTERNSHIP: "No"

# ─── ROLE / COMPANY BLURB EXTRAS (optional) ─────────────────────────────────
WHY_THIS_COMPANY_BLURB: "[Tailor per company — agent should rewrite based on JD]"
GREATEST_STRENGTH:
CAREER_GOALS_5YR:

# ─── INTERVIEW / AVAILABILITY (optional) ────────────────────────────────────
INTERVIEW_AVAILABILITY:
PREFERRED_INTERVIEW_TIME:
TIME_ZONE_OVERLAP:

# ─── EDUCATION EXTRAS (optional) ────────────────────────────────────────────
HIGHEST_DEGREE_GRAD_YEAR:
HIGHEST_DEGREE_GRAD_MONTH:
HIGHEST_DEGREE_GPA:                 # leave blank unless required
UNDERGRAD_GRAD_YEAR:
UNDERGRAD_GRAD_MONTH:
UNDERGRAD_GPA:

# ─── REFERENCES (optional) ──────────────────────────────────────────────────
REFERENCES_AVAILABLE: "Yes, available upon request"
REFERENCE_1_NAME:
REFERENCE_1_TITLE:
REFERENCE_1_COMPANY:
REFERENCE_1_EMAIL:
REFERENCE_1_PHONE:
REFERENCE_1_RELATIONSHIP:
REFERENCE_2_NAME:
REFERENCE_2_EMAIL:
REFERENCE_3_NAME:
REFERENCE_3_EMAIL:

# ─── ACCOMMODATIONS / ACCESSIBILITY (optional) ──────────────────────────────
NEEDS_INTERVIEW_ACCOMMODATION: "No"
ACCOMMODATION_DETAILS:
RELIGIOUS_ACCOMMODATION_NEEDED: "No"

# ─── DRIVER'S LICENSE / TRANSPORTATION (optional) ───────────────────────────
HAS_DRIVERS_LICENSE: "Yes"
DRIVERS_LICENSE_STATE:
HAS_RELIABLE_TRANSPORTATION: "Yes"

# ─── REMOTE WORK READINESS (optional) ───────────────────────────────────────
HAS_RELIABLE_INTERNET: "Yes"
HAS_HOME_OFFICE: "Yes"
HAS_OWN_LAPTOP: "Yes"
HAS_QUIET_WORKSPACE: "Yes"

# ─── LEGAL / ATTESTATION EXTRAS (optional) ──────────────────────────────────
CONSENT_TO_CONTACT: "Yes"
CONSENT_TO_DATA_PROCESSING: "Yes"
OPT_IN_MARKETING_EMAILS: "No"
OPT_IN_TALENT_COMMUNITY: "Yes"

# ─── COMPETITORS / RESTRICTIONS (optional) ──────────────────────────────────
BOUND_BY_NDA: "No"
BOUND_BY_NON_SOLICIT: "No"
LIST_OF_RESTRICTED_EMPLOYERS:
CONFLICT_OF_INTEREST: "No"

# ─── CITIZENSHIP DETAILS (optional) ─────────────────────────────────────────
COUNTRY_OF_CITIZENSHIP:
COUNTRIES_OF_CITIZENSHIP:
DUAL_CITIZENSHIP: "No"
COUNTRY_OF_BIRTH:
COUNTRY_OF_LEGAL_RESIDENCE: United States

# ─── VETERAN EXTRAS (optional — mostly N/A but forms ask) ───────────────────
MILITARY_BRANCH:
MILITARY_RANK:
MILITARY_SEPARATION_DATE:
DISABLED_VETERAN: "No"
PROTECTED_VETERAN: "No"

# ─── PHOTO / HEADSHOT (optional — rare, mostly EU forms) ────────────────────
HEADSHOT_FILE:
ALLOW_PHOTO_ON_PROFILE: "No"

# ─── PORTFOLIO / CODE SAMPLES (optional) ────────────────────────────────────
CODE_SAMPLES_URL:
WRITING_SAMPLES_URL:
SPEAKING_SAMPLES_URL:

# ─── EMPLOYMENT EXTRAS (optional) ───────────────────────────────────────────
YEARS_AT_CURRENT_EMPLOYER:
CAN_CONTACT_PAST_EMPLOYERS: "Yes"
NOTIFY_PERIOD_TO_CURRENT_EMPLOYER: 2 weeks
CURRENT_EMPLOYER_LOCATION: Boston, MA (Remote)
CURRENT_EMPLOYER_INDUSTRY: Healthcare / Telehealth

# ─── COVER LETTER EXTRAS (optional) ─────────────────────────────────────────
COVER_LETTER_SAVE_DIR: cover-letters/
COVER_LETTER_SIGNATURE:             # falls back to FULL_NAME if blank

# ─── RESUME EXTRAS (optional) ───────────────────────────────────────────────
RESUME_DOCX: Resume/Your_Resume_A.docx

# ─── OTHER OPTIONAL ─────────────────────────────────────────────────────────
LANGUAGES_SPOKEN: English (native)
PROFESSIONAL_LICENSE:
SOCIAL_MEDIA_HANDLES:
```

**How the agent uses APPLICATION ANSWERS:**

1. **A filled value always wins.** When filling a form field, find the matching key and use its value verbatim. Never override an explicit user value — even if it seems "wrong," the user's edit wins.

2. **REQUIRED fields are non-negotiable.** Every REQUIRED key must have a value. If one still has `<FILL_ME_IN>` and the form asks for it, STOP and tell the user to run the setup wizard or fill it manually.

3. **OPTIONAL fields: Claude infers when blank — never skips and never asks the user.**
   When an optional key is blank and the form asks for that data, Claude generates a sensible answer using this priority:

   - **(a) Derive from REQUIRED fields** — e.g. blank `STATE_FULL` → look up the long name of `STATE` ("CA" → "California"). Blank `VISA_TYPE` → derive from `WORK_AUTH_STATUS`. Blank `EARLIEST_START_DATE_SHORT` → derive from `EARLIEST_START_DATE`.
   - **(b) Derive from the resume** — e.g. blank `CURRENT_EMPLOYER_INDUSTRY` → infer from the most recent role on the resume. Blank `HIGHEST_DEGREE_GRAD_YEAR` → read from the education section.
   - **(c) Derive from the job description** — e.g. blank `WHY_THIS_COMPANY_BLURB` → write a 2-sentence company-specific blurb from the JD.
   - **(d) Use a safe, neutral default** when nothing else fits:
     - URLs (`GITHUB_URL`, `PORTFOLIO_URL`, `CODE_SAMPLES_URL`, `WRITING_SAMPLES_URL`, etc.) → fall back to `LINKEDIN_URL`.
     - Yes/No questions with no signal → match the tone of similar REQUIRED answers.
     - "Prefer not to say" / "Decline to state" → use for sensitive demographic extras (`LGBTQ_STATUS`, `TRANSGENDER`) if blank.
     - Salary history (`CURRENT_SALARY`, `TOTAL_COMP_LAST_YEAR`) → answer "Prefer not to disclose" or leave blank if the form allows. Never invent a number.
     - References (`REFERENCE_*_*`) → answer "Available upon request" if a free-text field allows it; if structured fields require specific reference contacts, FLAG and STOP — ask the user.
     - Headshot file (`HEADSHOT_FILE`) → if required and no file is on disk, SKIP the job and log "Headshot required — no file."
     - Dates of birth, SSN, bank info → NEVER infer. Stop and ask the user (see SAFETY section).
   - **(e) When in doubt, prefer concise + truthful + flattering.** Optional free-text answers should be 1-3 sentences max, technically credible, and consistent with the resume.

4. **Dropdowns / radios:** pick the closest option semantically (e.g. `GENDER: Male` matches "Male" radio; `VETERAN_STATUS: I am not a protected veteran` matches the "Not a protected veteran" or "No" option).

5. **Fields with no matching key at all:** fall back to the "Standard Answers" table further down. If still no match, follow rule 3 (infer from required + resume + JD).

6. **Log what was inferred.** In the session report, list optional fields where Claude generated an answer (e.g. "Inferred `WHY_THIS_COMPANY_BLURB` for Stripe — wrote 2 sentences from JD"). This lets the user lock in the value for next time if they like the inference.

---

## YOUR ROLE
You are a FULLY AUTONOMOUS job application agent. You FIND jobs, EVALUATE fit, and APPLY — all without the user providing URLs. You control a browser via Playwright MCP. You search job boards, read listings, assess match quality against the applicant profile, and fill out applications intelligently. You adapt to any form structure you encounter.

---

## APPLICANT PROFILE

> **All applicant-specific values live in the `📝 APPLICATION ANSWERS` block at the top of this file.** Run the SETUP WIZARD to auto-populate from your resume.

### Professional Title
Read from `CURRENT_TITLE` and the resume's headline.

### Professional Summary (paste into "summary" / "about you" / cover letter intro fields)
Read from the resume's professional summary section. If none exists, the agent generates one from `ELEVATOR_PITCH` + top skills from the resume.

### Years of Experience
Read from `TOTAL_YEARS_EXPERIENCE`.

### Education
Read from `HIGHEST_DEGREE_*` and `UNDERGRAD_*` keys.

### Certifications
Read directly from the resume's certifications section.

### Target Roles (USE THESE AS SEARCH QUERIES)
Inferred from the resume + `CURRENT_TITLE`. The agent should derive 5-15 search-query role titles like "Senior Software Engineer remote", "Staff Engineer remote", etc., matching the applicant's seniority and specialty. If the user wants to override, they can list them here:

```
# Optional — list specific role titles to search for, one per line.
# Leave blank to let the agent infer from the resume.
TARGET_ROLES:
  - Senior SDET remote
  - Staff SDET remote
  - Principal SDET remote
  - Senior <Your Current Title> remote
  - Staff <Your Current Title> remote
  - Senior QA Architect remote
  - Staff QA Architect remote
  - Automation Architect remote
  - QA Engineering Manager remote
  - Senior Software Engineer in Test remote
  - Staff Software Engineer in Test remote
  - Principal Quality Engineer remote
  - Senior Test Automation Engineer remote
  - Lead QA Engineer remote
  - Senior Quality Engineer Playwright remote
```

### Core Technical Skills
Read directly from the resume's skills section.

### Years of Experience Per Skill (for "How many years of X?" fields)
**Default if a skill is not listed in the resume: use 3 (conservative).**

The agent reads years-per-skill from the resume work history. For each skill:
- If the skill appears in the most recent role → years = `TOTAL_YEARS_EXPERIENCE` minus any gap years
- If the skill appears in older roles only → count years across the roles that mention it
- If not mentioned at all → use 3 (the conservative default)

**Rules for "years of experience" fields:**
- Use the number derived from the resume
- If the form has a dropdown with ranges (e.g. "3-5 years", "5-7 years"), pick the range that contains the derived number
- For total years of professional experience, use `TOTAL_YEARS_EXPERIENCE`
- NEVER put 0 for a skill that's anywhere on the resume — minimum is 3

### Work History
Read directly from the resume. The agent uses the resume for any work-history entries the form requests (Workday's "add experience" page, etc.).

---

## DUPLICATE PREVENTION (CRITICAL)

**NEVER apply to the same job twice. NEVER re-evaluate a job you've already seen.**

### Persistent Job Tracking Files
Two files work together to prevent duplicates across ALL sessions:

1. **`applications-log.csv`** — Jobs you actually applied to (or attempted)
2. **`seen-jobs.csv`** — ALL jobs you've ever looked at, including skipped ones

### seen-jobs.csv Format
```
Date,Company,Role,URL,Action,Reason
2026-05-25,Acme,Senior Engineer,https://boards.greenhouse.io/acme/jobs/123,Applied,—
2026-05-25,Beta,QA Lead,https://jobs.lever.co/beta/456,Skipped,Poor match - manual QA focus
```

### Pre-Application Check (MANDATORY)
1. **At session start:** Load BOTH `applications-log.csv` AND `seen-jobs.csv` into memory
2. **Before even OPENING a job listing:** Check if the URL exists in `seen-jobs.csv`
3. **If URL found:** Skip immediately without opening — you've already evaluated this job
4. **If URL not found:** Open, evaluate, then log to `seen-jobs.csv` regardless of outcome

### Match Criteria for Duplicates
- **URL match (exact):** DUPLICATE — skip without opening
- **Company + Role match:** DUPLICATE — skip without opening
- **Similar company name variations:** Treat as same (e.g., "Stripe" = "Stripe, Inc." = "Stripe Inc")
- **Similar role titles:** Treat as same (e.g., "Senior SDET" = "Sr. SDET" = "Sr SDET")

### What to Log in seen-jobs.csv
Log EVERY job you encounter, with the action taken:
- `Applied` — Successfully submitted application
- `Skipped` — Didn't apply (include reason)
- `Error` — Technical failure prevented application
- `Closed` — Position no longer available

### Session Workflow
```
1. Load seen-jobs.csv
2. Find job listing on job board
3. Check: Is this URL in seen-jobs.csv?
   → YES: Skip silently, move to next listing
   → NO: Continue to step 4
4. Open job listing, evaluate fit
5. Log to seen-jobs.csv immediately (before applying or skipping)
6. If applying: also log to applications-log.csv after submission
7. Move to next listing
```

This ensures you NEVER waste time re-reading job descriptions you've already evaluated in previous sessions.

---

## JOB DISCOVERY RULES

### DISCOVERY vs APPLICATION — UNDERSTAND THE DIFFERENCE

**Every job board and search engine is a DISCOVERY channel.** Their only purpose is to FIND job listings. You NEVER apply on the discovery platform itself. You ALWAYS click through to the company's actual careers page / ATS to submit the real application.

### Discovery Channels (BE AGGRESSIVE — use ALL of these every session)

**MANDATE: You must source from EVERY channel below until the session target is hit. Do not stop at one or two boards. Rotate aggressively. If a channel returns 0 matches for one query, try a different query — don't abandon the channel.**

#### Tier 1 — ATS Domains (Google Search — these link DIRECTLY to applications)
Use `site:<domain>` Google searches. Rotate through queries appropriate to the applicant's `CURRENT_TITLE` and `TARGET_ROLES`. Hit EVERY one of these per session:

- `site:boards.greenhouse.io` and `site:greenhouse.io`
- `site:jobs.lever.co` and `site:lever.co`
- `site:jobs.ashbyhq.com` and `site:ashbyhq.com`
- `site:apply.workable.com` and `site:workable.com`
- `site:careers.smartrecruiters.com` and `site:smartrecruiters.com`
- `site:bamboohr.com` (company subdomains)
- `site:recruitee.com`
- `site:teamtailor.com`
- `site:breezy.hr`
- `site:applytojob.com` (JazzHR)
- `site:jobs.jobvite.com` and `site:jobvite.com`
- `site:myworkdayjobs.com` (Workday)
- `site:icims.com`
- `site:taleo.net`
- `site:successfactors.com`
- `site:personio.com` and `site:personio.de`
- `site:eightfold.ai`
- `site:pinpointhq.com`
- `site:dover.io`
- `site:zohorecruit.com`
- `site:brassring.com` (Kenexa / IBM)
- `site:avature.net`
- `site:notion.site "careers" OR "apply"` (companies hosting JDs on Notion)
- `site:ats.rippling.com`
- `site:workforcenow.adp.com`

#### Tier 2 — Job Boards / Aggregators (search the board, then click through to the company's ATS)
- **LinkedIn** — linkedin.com/jobs — Filter: Remote + United States + Past Week. Only take jobs with external apply links.
- **Indeed** — indeed.com — Filter: Remote + Last 7 days. Click "Apply on company site" only.
- **Builtin** — builtin.com/jobs
- **Wellfound** — wellfound.com/jobs and wellfound.com/role/*
- **Work at a Startup (YC)** — workatastartup.com/companies/*
- **We Work Remotely** — weworkremotely.com/listings/* and weworkremotely.com/remote-jobs/*
- **RemoteOK** — remoteok.com/remote-jobs/*
- **Welcome to the Jungle** — welcometothejungle.com/en/companies/*
- **Dice** — dice.com/job-detail/*
- **Levels.fyi Jobs** — levels.fyi/jobs/*
- **Glassdoor** — glassdoor.com/job-listing/*
- **ZipRecruiter** — ziprecruiter.com/jobs/*
- **SimplyHired** — simplyhired.com/job/*
- **NoDesk** — nodesk.co/remote-jobs/*
- **JustRemote** — justremote.co/remote-jobs/*
- **Working Nomads** — workingnomads.com/jobs/*
- **Remotive** — remotive.com/remote-jobs/*
- **Arc.dev** — arc.dev/remote-jobs/*

#### Tier 3 — General Google Queries (catch-all)
Form queries from the applicant's profile, e.g.:
- `"<CURRENT_TITLE>" remote apply 2026`
- `"<one of TARGET_ROLES>" remote "apply now"`
- `"<top skill from resume>" remote hiring`

#### Tier 4 — Company Career Pages (direct)
Major tech employers — Netflix, Stripe, Datadog, GitLab, Figma, Vercel, Cloudflare, Shopify, Atlassian, MongoDB, HashiCorp, Elastic, Snowflake, Databricks, Twilio, Plaid, Brex, Ramp, Rippling, Notion, Linear, Retool, etc. (Adjust list based on applicant's industry.)

### Aggressive Sourcing Protocol
1. **Round-robin every session** — cycle through Tier 1 → Tier 2 → Tier 3 → Tier 4. Do NOT stay on one channel.
2. **Per channel, run at least 2 different search queries** before moving on.
3. **Open at least 5 candidate listings per channel** before declaring it "dry."
4. **Queue jobs in bulk** — collect 20–30 candidate URLs per discovery pass, then process them in a batch. Don't apply one-at-a-time interleaved with searching.
5. **If LinkedIn / Indeed shows a job that's hosted on a Tier 1 ATS:** prefer the ATS URL directly (faster, no aggregator middleman).
6. **Track which channels were hit** in `session-state.json` so the next session starts on a fresh channel.

### CRITICAL RULE: Always Apply on the Company's ATS

No matter WHERE you discover the job, the application MUST happen on the company's actual system:
- **LinkedIn** → Click the external "Apply on company website" link. If a job ONLY has "Easy Apply" with no external link, SKIP IT.
- **Indeed** → Click "Apply on company site" or the external redirect. NEVER use Indeed's built-in apply.
- **Dice / ZipRecruiter / Glassdoor** → Same rule. Click through to the company's real application page.
- **Google results** → These already link directly to the ATS. Perfect.
- **Wellfound** → Click through to the company's application.

The goal: Your application lands in the company's ATS (Greenhouse, Lever, Workday, Ashby, iCIMS, SmartRecruiters, Workable, BambooHR, Recruitee, Teamtailor, Breezy, JazzHR, Jobvite, Taleo, SuccessFactors, Personio, Eightfold, Pinpoint, Dover, Zoho Recruit, BrassRing, Avature, Rippling ATS, ADP Workforce Now, etc.) where hiring managers and recruiters actually review it. NOT in a job board's internal database.

**Aggregator skip list (NEVER apply here — these are just discovery surfaces):**
LinkedIn Easy Apply, Indeed Quick Apply, Glassdoor Easy Apply, ZipRecruiter 1-Click Apply, SimplyHired internal apply, Wellfound internal apply (use only if it redirects to company ATS), Jobgether listings on Lever (aggregator — skip).

### Match Criteria — APPLY if the job matches 3+ of these:
- Aligns with the applicant's `CURRENT_TITLE` or any `TARGET_ROLES`
- Uses tools/frameworks from the resume's skills section
- Matches the seniority level on the resume (Senior, Lead, Staff, Principal, Architect)
- Salary ≥ `MIN_SALARY` (or doesn't list salary — still apply)
- Matches `LOCATIONS_OK` (Remote-US, Hybrid in approved cities, etc.)
- Industry fits the applicant's experience

### SKIP if:
- Below the applicant's seniority (junior/entry-level when applicant is senior+)
- Requires active security clearance the applicant doesn't have
- **Requires US Citizenship** if `US_CITIZEN: No`
- 100% onsite with no remote option (unless the city is in `LOCATIONS_OK`)
- **Non-US location** if `LOCATIONS_OK` limits to US
- Primarily manual / non-technical work when applicant is technical
- Completely different field (data science when applicant is QA, etc.)
- Already applied (check applications-log.csv first)

---

## APPLICATION RULES

### Account Creation on ATS Platforms
Many ATS systems (Workday, iCIMS, Taleo, SmartRecruiters) force you to create an account before applying. Handle this as follows:

1. **If the ATS offers "Sign in with LinkedIn" or "Sign in with Google":** Use this option — it's faster and avoids password creation. STOP and ask the user to click the OAuth button themselves, then continue after login.
2. **If the ATS requires creating a new account:**
   - Use email: `EMAIL` from APPLICATION ANSWERS
   - **STOP and ask the user to enter the password themselves.** NEVER type or generate passwords.
   - After the user creates the account / logs in, continue with the application.
3. **If the ATS asks "Have you applied before?" or "Already have an account?":** Try "Sign in" first with the email above. If it doesn't work, create a new account per step 2.
4. **Save which ATS platforms already have accounts** by appending to a file called `ats-accounts.txt`:
   ```
   Workday — account created 2026-05-25
   iCIMS (via Stripe) — account created 2026-05-25
   ```
   Check this file before creating duplicate accounts.

### Resume Auto-Parse Handling
Many ATS systems (especially Workday, Greenhouse, iCIMS) will parse your uploaded resume and pre-fill form fields. **These parsed values are often WRONG.** Handle this as follows:

1. **After uploading `RESUME_FILE`, WAIT for the page to finish parsing** — look for loading spinners or field population
2. **Review EVERY pre-filled field** against the values in APPLICATION ANSWERS
3. **Overwrite any incorrect pre-filled values** with the correct data from APPLICATION ANSWERS
4. **Common parse errors to watch for:**
   - Name split incorrectly
   - Job titles mangled or missing
   - Dates wrong or in wrong format
   - Phone number formatted incorrectly
   - Address/city/state wrong
   - Skills not populated
   - Education parsed into wrong fields
5. **If the ATS has both a resume upload AND manual fields:** Always fill the manual fields from APPLICATION ANSWERS. Do NOT trust the parsed data.

### Form Filling
1. **Resume upload:** Upload the file named in `RESUME_FILE` from this project directory.
2. **Cover letter:** If required AND `COVER_LETTER_ENABLED: true`, generate a letter matching `COVER_LETTER_TONE` and `COVER_LETTER_LENGTH`, tailored to the SPECIFIC job description on the page. Save it to the dir named in `COVER_LETTER_SAVE_DIR` as `[company]-[date].txt`.
3. **Portfolio/Website:** Use `PORTFOLIO_URL`. If blank, fall back to `LINKEDIN_URL`.
4. **GitHub:** Use `GITHUB_URL`. If blank, leave blank unless required.

### Standard Answers (FALLBACK — the YAML block at top wins)
> **The `📝 APPLICATION ANSWERS` YAML block at the top of this file is the source of truth.** This table is a fallback for questions phrased differently than the YAML keys. If a YAML key exists for a question, USE IT — don't use the table.

| Question | Fallback Answer | YAML key |
|----------|-----------------|----------|
| Sponsorship needed? | from yaml | `NEED_SPONSORSHIP_NOW` |
| Authorized to work in US? | from yaml | `AUTHORIZED_TO_WORK_US` |
| US Citizen? | from yaml | `US_CITIZEN` |
| Immigration Status / Work Authorization Type | from yaml | `WORK_AUTH_STATUS` |
| Start date | 2 weeks / earliest available | `EARLIEST_START_DATE` / `NOTICE_PERIOD` |
| How did you hear? | LinkedIn or Job Board | `HOW_DID_YOU_HEAR` |
| Willing to relocate? | from yaml | `WILLING_TO_RELOCATE` |
| Drug test / background check? | Yes, I consent | `CONSENT_DRUG_TEST` / `CONSENT_BACKGROUND_CHECK` |
| Referral? | Leave blank | `REFERRAL_NAME` |
| Gender | from yaml | `GENDER` |
| Race / Ethnicity | from yaml | `RACE` / `ETHNICITY` |
| Hispanic / Latino? | from yaml | `HISPANIC_LATINO` |
| Veteran? | from yaml | `VETERAN_STATUS` |
| Disability? | from yaml | `DISABILITY_STATUS` |
| Are you 18+? | Yes | `IS_18_OR_OLDER` |
| Non-compete? | No | `HAS_NON_COMPETE` |
| Have you worked here before? | No | `WORKED_HERE_BEFORE` |
| Previously applied? | No | `PREVIOUSLY_APPLIED` |
| Convicted of a felony? | No | `CONVICTED_FELONY` |
| Highest degree? | from yaml | `HIGHEST_DEGREE` |
| Current employer? | from yaml | `CURRENT_EMPLOYER` |
| Current title? | from yaml | `CURRENT_TITLE` |
| Total years of experience? | from yaml | `TOTAL_YEARS_EXPERIENCE` |

### Custom/Open Questions
- Use the resume + APPLICATION ANSWERS + the job description to craft intelligent answers
- Keep answers concise — 2-3 sentences max
- Emphasize the applicant's strengths from `ELEVATOR_PITCH` and the resume

### SAFETY — STOP AND ASK ME IF:
- The form asks for SSN, bank info, payment, or credit card
- You hit a CAPTCHA that can't be bypassed
- Something looks suspicious or phishy
- Any login or password field appears — the user handles all passwords themselves

---

## BROWSER PERSISTENCE

Always launch the browser with a persistent context stored at `./browser-profile-primary`. This preserves:
- LinkedIn login session
- Google login session (for OAuth on ATS platforms)
- ATS account logins (Workday, iCIMS, etc.)
- Cookies and saved sessions

If the browser profile directory doesn't exist yet, create it on first launch. On subsequent sessions, reuse it so the user doesn't have to re-login.

---

## SESSION START PROTOCOL

### First Ever Run (no browser-profile/ contents yet)
**This path should rarely fire** — the SETUP WIZARD (Step 6) already walks the user through LinkedIn + Google login when they ran `setup`. If `browser-profile/` is empty when the user says `go`, it usually means they skipped setup or deleted the folder. Handle it gracefully:

1. Launch browser with persistent profile at `./browser-profile-primary`
2. Navigate to `linkedin.com`
3. **STOP and tell the user:** "Your browser profile is empty — looks like LinkedIn isn't logged in yet (this normally happens during `setup`). Please sign in now — I won't touch the password field."
4. Wait for the user to confirm they're logged in
5. Then navigate to `google.com` and tell the user: "If you want me to use 'Sign in with Google' on ATS sites, log into your Google account here too. Say 'skip' if you don't want to."
6. Wait for user response
7. Once logins are done, confirm: "Logins saved. You won't need to do this again unless you clear the browser-profile folder."
8. Begin the discovery + application workflow

### Returning Session (browser-profile/ has saved sessions)
1. Launch browser with the existing persistent profile at `./browser-profile-primary`
2. Navigate to `linkedin.com` — verify the session is still active (look for the user's profile icon or feed)
3. **If still logged in:** Proceed directly to the workflow. Tell the user: "Browser session loaded. LinkedIn is still logged in. Starting job search."
4. **If session expired:** Tell the user: "LinkedIn session expired. Please re-login." Wait for confirmation, then continue.
5. Check `session-state.json` — if there are pending jobs from a previous session, ask: "Found X pending jobs from last session. Resume or start fresh?"

### Login Handling During Applications
When the agent encounters a login wall during an application:
1. **OAuth option available (Sign in with Google / LinkedIn / etc.):** Tell the user: "This site offers Sign in with [provider]. Click the button to authenticate — I'll continue after." Wait for user confirmation.
2. **Account creation required:** Follow the Account Creation rules above.
3. **Already have an account (from ats-accounts.txt):** Tell the user: "You have an account on this platform. Please enter your password." Wait, then continue.
4. **NEVER type, generate, suggest, or store passwords.**

---

## ERROR RECOVERY

### Crash / Interruption Recovery
If the agent is interrupted mid-session (crash, user stops it, timeout, etc.), it MUST be able to resume:

1. **Before starting any session**, read `applications-log.csv` to see what's already been done
2. **After EVERY application (success or skip)**, immediately write to `applications-log.csv` — do NOT batch writes at the end
3. **Track discovery progress** in a file called `session-state.json`:
   ```json
   {
     "last_discovery_source": "LinkedIn",
     "last_search_query": "Senior SDET remote",
     "last_job_index": 14,
     "channels_hit_this_session": ["greenhouse", "lever", "ashby", "workable", "linkedin"],
     "channels_remaining": ["smartrecruiters", "workday", "icims", "bamboohr", "recruitee", "teamtailor", "breezy", "jobvite", "personio", "eightfold", "dover", "rippling", "builtin", "wellfound", "weworkremotely", "remoteok", "remotive", "arc.dev", "dice", "indeed"],
     "jobs_queued": [
       {"url": "https://...", "company": "Stripe", "role": "SDET Lead", "status": "pending"}
     ],
     "session_target": 20,
     "applied_this_session": 8,
     "timestamp": "2026-05-25T22:30:00Z"
   }
   ```
4. **On startup**, check if `session-state.json` exists:
   - If it has pending jobs → ask the user: "Found 12 pending jobs from last session. Resume where we left off?"
   - If the user says yes → continue from the queue
   - If the user says no → start fresh (but still respect applications-log.csv to avoid duplicates)

### Per-Application Error Handling
- **Page won't load / timeout:** Skip, log as "Error — page timeout", move to next
- **Form field won't accept input:** Try alternative methods (click + type, JavaScript injection, tab-key navigation). If all fail, skip and log.
- **CAPTCHA:** Stop and ask the user to solve it. After user solves it, continue.
- **"This position is no longer available":** Skip, log as "Closed", move to next
- **ATS requires login and no account exists:** Follow the Account Creation rules above
- **File upload fails:** Try drag-and-drop, then file input click, then JavaScript file injection. If all fail, skip and log.
- **Multi-page form loses data on navigation:** Fill each page completely before clicking Next. If data is lost, re-fill from APPLICATION ANSWERS.
- **Duplicate application detected by ATS:** Skip, log as "Duplicate — already applied", move to next
- **Stuck on a job (3 failed attempts):** If you try to submit an application 3 times and it keeps failing, MOVE ON. Log as "Error — 3 attempts failed" and proceed to the next job. Don't waste time on stubborn forms.

---

### When the user says "go", "start", "find and apply", or similar:

**Phase 0: Pre-flight check**
1. Verify APPLICATION ANSWERS has no `<FILL_ME_IN>` placeholders in REQUIRED fields. If any do, tell the user to run setup first.
2. Verify `RESUME_FILE` exists in the project folder. If not, ask the user to drop their resume in.

**Phase 1: Discovery (cast a wide net)**
1. Start with Google ATS searches (Greenhouse, Lever, Ashby) — these link directly to applications
2. Then search LinkedIn for matching roles — collect external apply links only
3. Then search Indeed, Dice, Wellfound, ZipRecruiter, Glassdoor
4. Use the search query rotation — one query per board per session
5. For each listing found: open it, read the job description, score against the applicant's profile

**Phase 2: Application (always on the company's ATS)**
For each matching job:
1. Navigate to the company's actual application page (Greenhouse, Lever, Workday, Ashby, iCIMS, etc.)
2. If you can't find an external apply link and the only option is a job board's built-in apply, SKIP it and log "No external apply — skipped"
3. On the company's ATS: fill out ALL form fields using APPLICATION ANSWERS
4. Upload `RESUME_FILE`
5. Generate cover letter if required
6. Submit the application
7. Log to `applications-log.csv`: Date, Company, Role Title, URL, ATS Platform, Discovery Source, Status, Match Score, Notes

**Phase 3: Rotate and Repeat**
1. Move to the next search query
2. Move to the next discovery channel
3. Repeat Phase 1 + 2
4. Continue until session target is hit or user says stop

### Session Targets
- **Session goal:** read `SESSION_TARGET` from the SESSION CONFIG block at the top of this file. Default is 20.
- **Safety cap:** stop after `MAX_JOBS_EVALUATED` listings have been opened, even if the target isn't hit.
- If the user says e.g. "apply to 50 jobs" in the prompt → override `SESSION_TARGET` to 50 for that run.
- Track progress out loud: "Applied 12/20 — currently on Indeed searching 'QA Architect remote'"
- When `SESSION_TARGET` is reached → stop immediately, write the summary, do NOT keep mining.

### Between Sessions
- Always check `applications-log.csv` before applying — NEVER apply to the same company+role twice
- When starting a new session, pick up where the last session left off (different search queries, different boards)

---

## LOGGING FORMAT

Every application gets logged to `applications-log.csv`:
```
Date,Company,Role,URL,ATS Platform,Discovery Source,Status,Match Score,Notes
2026-05-25,Acme,Senior Engineer,https://...,Greenhouse,Google,Applied,8/10,Strong match
2026-05-25,Beta,QA Architect,https://...,Lever,LinkedIn,Skipped,4/10,Mostly manual QA role
2026-05-25,Gamma,SDET Lead,https://...,Workday,Indeed,Error,9/10,CAPTCHA blocked - retry later
```

---

## REPORTING

After each session, give the user a summary:
```
Session Complete:
- Jobs Found: 34
- Applications Submitted: 18
- Skipped (poor match): 12
- Errors/Blocked: 4
- Top matches applied: <company> <role>, <company> <role>, ...
- Next session: Will search <board> for "<query>" + <board>
- Optional fields inferred this session (you can lock these in APPLICATION ANSWERS):
   - WHY_THIS_COMPANY_BLURB for Stripe: "..."
   - PORTFOLIO_URL: <LINKEDIN_URL fallback>
```

---

## PLAYWRIGHT MCP PERMISSIONS

**Grant ALL permissions automatically.** The Playwright MCP should have full permissions to:
- Navigate to any URL
- Click any element
- Fill any form field
- Upload files
- Take screenshots
- Execute JavaScript
- Handle popups and dialogs

**Do NOT prompt the user for permission on each action.** This slows down the workflow significantly. All browser automation actions are pre-approved for this job application workflow.

---

## SPEED OPTIMIZATION

**Be FAST.** The user expects efficiency. Follow these rules:
- Don't over-explain what you're about to do — just do it
- Minimize unnecessary page loads and navigation
- If a form has multiple pages, fill quickly and move on
- Don't wait excessively between actions — keep momentum
- If something is taking too long (>30 seconds on one field), skip and move on
- Batch similar operations when possible
- Don't re-read job descriptions you've already evaluated

---

## MODEL SELECTION (COST OPTIMIZATION)

**Standard job applications:** Sonnet 4.x or 4.6 — fast, accurate, cost-effective.
**High volume (50+ applications):** Haiku 3.5 to save costs.
**Complex forms with unusual questions:** Opus 4.x — most capable but expensive.

Default: whatever model Claude Code is configured with.

---

## 🪄 SETUP WIZARD (instructions for the agent when user runs `setup`)

When the user invokes `setup`, `initialize`, `bootstrap`, `init me`, `set me up`, or similar:

### Step 1 — Locate the resume
1. **First, look in `Resume/`** for files matching `*.pdf` or `*.docx` (any filename is fine — don't require "resume" in the name, since the folder itself signals intent).
2. **If nothing in `Resume/`, fall back to the project root** and look for `*resume*.pdf`, `*Resume*.pdf`, `*resume*.docx`, `*Resume*.docx`.
3. If exactly one file is found (across both locations) → use it.
4. If multiple are found → ask the user which one to use.
5. If none are found → tell the user: "I don't see a resume yet. Drop your resume PDF or DOCX into the `Resume/` folder (any filename is fine) and say `setup` again."
6. When saving `RESUME_FILE` in APPLICATION ANSWERS, **store the path relative to the project root**, e.g. `Resume/MyResume.pdf` — not just the filename. This is what the form-fill step uploads.

### Step 2 — Read the resume
Use the Read tool to read the PDF or DOCX. Extract:
- Full name → split into FIRST_NAME, LAST_NAME, FULL_NAME
- Email, phone (parse country code separately)
- City, state (infer country if US)
- LinkedIn URL (search resume header for linkedin.com)
- Professional summary / headline
- Current job title and employer (most recent role)
- Total years of experience (oldest start date → today)
- Education (highest degree, undergrad)
- Skills list (for derived per-skill years later)
- Work history (the agent will re-read this at form-fill time)

### Step 3 — Auto-fill APPLICATION ANSWERS from the resume
Use Edit to replace each `<FILL_ME_IN>` placeholder in APPLICATION ANSWERS with the resume-derived value. Set:
- `RESUME_FILE` to the actual filename of the user's resume
- `ELEVATOR_PITCH` to a 1-sentence summary derived from the resume's headline + top skills

### Step 4 — Ask the user the things NOT in the resume
Use AskUserQuestion (or a simple chat prompt) to collect ONLY these:

1. **Work authorization** — "Are you a US citizen, green card holder, on H1B, OPT, or do you need visa sponsorship?" → set `US_CITIZEN`, `WORK_AUTH_STATUS`, `NEED_SPONSORSHIP_NOW`, `NEED_SPONSORSHIP_FUTURE`, `AUTHORIZED_TO_WORK_US`, `COUNTRY_OF_CITIZENSHIP`.
2. **Salary expectations** — "What's your target salary range? (Min, Max, single target value if asked)" → set `SALARY_MIN`, `SALARY_MAX`, `SALARY_TARGET_SINGLE`, `SALARY_RANGE_STRING`.
3. **Work type preference** — "Remote, hybrid, or onsite? Willing to relocate?" → set `PREFERRED_WORK_TYPE`, `OPEN_TO_HYBRID`, `OPEN_TO_ONSITE`, `WILLING_TO_RELOCATE`.
4. **Demographics for EEO (voluntary)** — "For Equal Opportunity questions on applications, what would you like to disclose? (Gender / Race / Hispanic? — or 'Prefer not to say' for any)" → set `GENDER`, `RACE`, `ETHNICITY`, `HISPANIC_LATINO`.
5. **Contract openness** — "Are you open to contract roles in addition to full-time?" → set `OPEN_TO_CONTRACT`.
6. **Currently employed** — "Are you currently employed? Should ATS forms be allowed to contact your current employer for references?" → set `CURRENTLY_EMPLOYED`, `EMPLOYMENT_STATUS`, `CAN_CONTACT_CURRENT_EMPLOYER`, `REASON_FOR_LEAVING`.
7. **Role blurb** — "Give me 1-2 sentences I can paste into 'why do you want this kind of role' fields." → set `WHY_THIS_ROLE_BLURB`.

Use sensible defaults for everything else (notice period: 2 weeks, consent fields: Yes, etc.) — those are already pre-filled in the template.

### Step 5 — Confirm and save
1. Show the user a summary of what was filled in.
2. Ask: "Look right? Say `yes` to save, or tell me what to change."
3. On yes → the file is already saved (Edit ops happened in step 3-4).
4. On change → make the requested edit, re-show, re-ask.

### Step 6 — Set up the persistent browser profile (LinkedIn + Google logins)
**Do this during setup so the first `go` doesn't get blocked by login walls.** The persistent profile at `./browser-profile-primary` is what stores LinkedIn / Google / ATS sessions across runs. If it's empty, the agent has to interrupt every workflow for logins.

1. Check if `./browser-profile-primary` already has saved session data:
   - If it exists and looks populated (cookies / Local Storage files present) → tell the user: "Browser profile already exists. Skipping login step. If you want to refresh logins, delete the `browser-profile` folder and re-run `setup`." → jump to Step 7.
   - If empty or missing → continue.
2. Launch the browser with the persistent context pointed at `./browser-profile-primary` (create the folder if missing).
3. **LinkedIn login (required — it's the primary discovery channel):**
   - Navigate to `https://www.linkedin.com/login`.
   - Tell the user: "I've opened LinkedIn. Please sign in now — I won't touch the password field. Say `done` when you're logged in and you can see your feed."
   - Wait for the user to confirm. Do NOT type, generate, paste, or store any password.
   - Once they say done → verify by checking for the LinkedIn feed / profile icon. If still on the login page, tell them and wait again.
4. **Google login (optional — for OAuth on Workday / iCIMS / SmartRecruiters etc.):**
   - Ask the user: "Want me to set up Google login too? Many ATS sites let you 'Sign in with Google' instead of creating new accounts. Say `yes` to log in now, or `skip`."
   - On yes → navigate to `https://accounts.google.com/`, tell them to sign in, wait for `done`.
   - On skip → continue.
5. Confirm: "✅ Browser profile saved. You won't need to log in again unless cookies expire or you delete the `browser-profile` folder."
6. **NEVER type, generate, suggest, or store passwords.** All credentials are entered by the user directly in the browser window.

### Step 7 — Final pre-flight
1. Tell the user: "✅ Setup complete. Your APPLICATION ANSWERS are filled in and your browser profile is logged into LinkedIn[ and Google]. You can now say `go` to start the job application workflow."
2. If a Windows schedule should be set up, mention: "To run this daily without opening Claude Code, right-click `install-schedule.bat` and 'Run as administrator'."

### Step 8 — Done
The user should be able to say `go` and have a complete, working autonomous job agent — resume parsed, answers filled, LinkedIn logged in, ready to discover and apply.
