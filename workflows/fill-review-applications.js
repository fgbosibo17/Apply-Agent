// ─────────────────────────────────────────────────────────────────────────────
// MULTI-AGENT FILL → REVIEW PIPELINE  (Claude Code `Workflow` script)
//
// The problem: the ATS handlers fill forms with keyword heuristics, which can get
// custom screening questions wrong (claiming a certification/degree/skill the
// applicant doesn't have, wrong location, etc.).
//
// The fix: TWO agents per job. A FILL agent fetches the job's REAL questions
// (via `node src/dump-questions.js <url>`) and drafts answers from the applicant's
// resume facts. Then an INDEPENDENT REVIEW agent audits every answer against
// those facts — correcting overclaims and rejecting jobs that require a
// credential/license/language the applicant lacks. The reviewed answers are
// written to data/verified-answers.json, which the ATS handlers consult FIRST
// (see src/util/verified.js), so the actual submission uses vetted answers.
//
// HOW TO RUN (from Claude Code, via the Workflow tool):
//   Workflow({ scriptPath: "workflows/fill-review-applications.js", args: {
//     jobs:  [{ url, company, role, persona }, ...],   // Greenhouse job URLs
//     facts: { <persona>: "<plain-text resume facts for that persona>", ... }
//   }})
// Then feed the returned `apply` list to:  node src/apply-verified.js <output.json>
// and submit with:  QUEUE=queue-approved-<persona>.json PERSONA=<persona> node src/index.js
//
// NOTE: `facts` is passed at run time and NEVER stored in this file — no PII lives
// in the repo. Only Greenhouse exposes a public questions API, so the fill agent
// works best on Greenhouse jobs.
// ─────────────────────────────────────────────────────────────────────────────

export const meta = {
  name: 'fill-review-applications',
  description: 'Fill each job application from resume facts, then independently review/correct until accurate before submit',
  phases: [
    { title: 'Fill', detail: 'one agent drafts answers from the real questions' },
    { title: 'Review', detail: 'a second agent audits answers vs resume, corrects or rejects' },
  ],
};

const FILL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    url: { type: 'string' },
    persona: { type: 'string' },
    applicable: { type: 'boolean', description: 'false if the job requires a credential/license/language/seniority the applicant lacks' },
    answers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, answer: { type: 'string' }, note: { type: 'string' } },
        required: ['label', 'answer'],
      },
    },
  },
  required: ['url', 'applicable', 'answers'],
};

const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    url: { type: 'string' },
    decision: { type: 'string', enum: ['apply', 'skip'] },
    reason: { type: 'string' },
    corrections_made: { type: 'string', description: 'what you changed and why' },
    answers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { label: { type: 'string' }, answer: { type: 'string' } },
        required: ['label', 'answer'],
      },
    },
  },
  required: ['url', 'decision', 'answers'],
};

const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !Array.isArray(A.jobs)) throw new Error('args.jobs missing or not an array; got: ' + typeof args);

const results = await pipeline(
  A.jobs,
  // STAGE 1 — FILL
  async (job) => {
    const facts = A.facts[job.persona];
    const out = await agent(
      `You are filling out a real job application for an applicant (${job.persona} resume). Job: ${job.role} at ${job.company}.\n\n` +
      `STEP 1: Run this bash command to get the EXACT application questions:\n  node "src/dump-questions.js" "${job.url}"\n\n` +
      `STEP 2: For EVERY question in the output, write a truthful answer using ONLY these facts:\n${facts}\n\n` +
      `HARD RULES (be strict — never lie):\n` +
      `- NEVER claim a degree, certification, license, or language the applicant does not have. If asked about a certification they lack, answer "No".\n` +
      `- NEVER claim years/experience with a tool or skill not in the facts. If unsure, answer honestly ("No" or a low/honest value).\n` +
      `- Standard fields (name, email, phone, work auth, gender, race, veteran, disability, start date) come from the facts.\n` +
      `- SALARY: answer "Open" / "Negotiable" (no invented number). If the form STATES a specific pay rate/range and asks if comfortable, answer "Yes".\n` +
      `- LOCATION: "where are you located / based / city+state" -> the applicant's city+state; work-arrangement -> "Remote"; a physical-office dropdown -> "Remote"/"Other"/blank, NEVER a random office; country -> "United States".\n` +
      `- SCHOOL/education: use the applicant's real school and highest degree; never upgrade to a higher credential.\n` +
      `- For open-text "why" questions, write 1-2 honest sentences grounded in real experience. No invented metrics or stories.\n` +
      `- Set applicable=false if the job REQUIRES something the applicant lacks (a specific license, certification, non-English language, or is senior/manager level).\n\n` +
      `Return url, persona=${job.persona}, applicable, and answers (one per question with the exact label).`,
      { phase: 'Fill', label: `fill:${job.company}`, schema: FILL_SCHEMA }
    );
    return { job, fill: out };
  },
  // STAGE 2 — REVIEW (independent audit + correction)
  async (prev, job) => {
    if (!prev || !prev.fill) return null;
    const facts = A.facts[job.persona];
    const review = await agent(
      `You are an INDEPENDENT reviewer auditing a job application before submission. Be skeptical — assume there may be errors.\n\n` +
      `Job: ${job.role} at ${job.company}\n` +
      `The applicant's TRUE facts:\n${facts}\n\n` +
      `Proposed answers to audit:\n${JSON.stringify(prev.fill.answers, null, 2)}\n` +
      `Filler flagged applicable=${prev.fill.applicable}.\n\n` +
      `Review CLOSELY — check EVERY answer:\n` +
      `1. CERTIFICATIONS/LICENSES/DEGREE: never claim one the applicant lacks -> fix to "No"/"None"/their real level.\n` +
      `2. SKILLS/LANGUAGES: never claim a tool or language not in the facts. Fix overclaims.\n` +
      `3. SALARY: "Open"/"Negotiable" (or "Yes" to a stated pay range) — no invented number.\n` +
      `4. LOCATION: "where located/based" must be the applicant's real city+state (not a country); office-location dropdowns -> "Remote"/Other/blank, never a random city.\n` +
      `5. DEMOGRAPHICS/WORK-AUTH: match the facts exactly.\n` +
      `6. RELATIONSHIPS/REFERRALS: "No" unless the facts say otherwise.\n\n` +
      `If the role REQUIRES a credential/license/non-English language the applicant lacks, or is senior/manager level -> decision="skip" with reason.\n` +
      `Otherwise decision="apply" and return the FINAL CORRECTED answers (every question, exact labels). List changes in corrections_made.`,
      { phase: 'Review', label: `review:${job.company}`, schema: REVIEW_SCHEMA }
    );
    return { job, review };
  }
);

const clean = results.filter(Boolean);
const apply = clean.filter((r) => r.review && r.review.decision === 'apply');
const skip = clean.filter((r) => r.review && r.review.decision === 'skip');
log(`Reviewed ${clean.length} jobs: ${apply.length} to APPLY, ${skip.length} to SKIP`);
return {
  apply: apply.map((r) => ({ url: r.job.url, company: r.job.company, role: r.job.role, persona: r.job.persona, answers: r.review.answers })),
  skip: skip.map((r) => ({ url: r.job.url, company: r.job.company, role: r.job.role, reason: r.review.reason })),
};
