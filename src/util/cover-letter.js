// Cover letters: only when required, and only written for THIS persona and THIS job.
//
// WHAT WAS WRONG
// greenhouse.js had a hardcoded coverLetterText() that produced a Cloud/DevOps pitch —
// "hands-on depth in AWS and Azure, CI/CD, identity/access, and incident response" —
// regardless of which persona was applying. The QA persona was sending a DevOps letter
// to QA roles. It also fired whenever a cover-letter field merely EXISTED, so optional
// fields got filled too.
//
// A generic letter is worse than no letter. A hiring manager reading a DevOps pitch on a
// QA application learns one thing: this was mass-sent. The resume alone would have read
// better. So:
//
//   optional field  ->  leave it empty, always
//   required field  ->  write one for this persona and this posting
//
// The generated letter is grounded the same way tailoring is: it may only draw on facts
// already in the persona. If the model is unreachable, the fallback is built from persona
// fields rather than invented prose, and it stays short — a brief honest note beats a
// confident paragraph about experience the candidate does not have.

// ── talking to Prime's generic inference endpoint ────────────────────────────────
// Derived from the tailor endpoint so there is one URL to configure, not two.
const orchestrator = require('./orchestrator');

function inferUrl() {
  const t = orchestrator.tailorEndpoint && orchestrator.tailorEndpoint();
  return t ? String(t).replace(/\/tailor\b/, '/infer') : '';
}

async function infer({ system, prompt, model = 'haiku', maxTokens = 500 }) {
  const url = inferUrl();
  if (!url) throw new Error('no inference endpoint configured');
  const token = (orchestrator.serviceToken && orchestrator.serviceToken()) || '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.APPLY_AGENT_TAILOR_TIMEOUT_MS || 120000));
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ model, system, prompt, max_tokens: maxTokens }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    return (d && d.text) || '';
  } finally { clearTimeout(timer); }
}

const SYSTEM = [
  'You write a short, specific cover letter for a job application.',
  '',
  'HARD RULES:',
  '- Use ONLY facts present in the candidate summary given to you. Never introduce an',
  '  employer, tool, certification, metric or year count that is not there.',
  '- Address the actual role and company named in the posting. If the posting names a',
  '  specific responsibility or tool the candidate genuinely has, say so concretely.',
  '- No flattery about the company, no "I am passionate about", no filler.',
  '- Three short paragraphs maximum. Under 200 words.',
  '- Plain text. No markdown, no placeholders, no bracketed TODOs.',
  '',
  'If the candidate summary does not support a claim the posting asks for, simply do not',
  'make that claim. A shorter honest letter is the correct output.',
].join('\n');

// What the model is allowed to draw on. Built from the persona so the letter can only
// contain things the resume already says.
function candidateSummary(a) {
  const bits = [
    `Name: ${a.fullName}`,
    a.currentTitle ? `Current focus: ${a.currentTitle}` : '',
    a.totalYearsExperience ? `Years of experience: ${a.totalYearsExperience}` : '',
    a.primaryStack ? `Core stack: ${a.primaryStack}` : '',
    a.targetRoles ? `Target roles: ${[].concat(a.targetRoles).join(', ')}` : '',
    a.elevatorPitch ? `Summary: ${a.elevatorPitch}` : '',
    a.whyThisRoleBlurb ? `Motivation: ${a.whyThisRoleBlurb}` : '',
  ];
  return bits.filter(Boolean).join('\n');
}

// Fallback when no model is reachable. Deliberately plain and short: it states who the
// candidate is and points at the resume. It does NOT describe experience in prose,
// because prose written from a template is exactly what produced the DevOps-letter bug.
function fallbackLetter(a, jobMeta) {
  const role = (jobMeta && jobMeta.role) || 'this role';
  const company = (jobMeta && jobMeta.company) || 'your team';
  const years = a.totalYearsExperience ? `${a.totalYearsExperience}+ years` : 'my experience';
  const focus = a.currentTitle || (Array.isArray(a.targetRoles) ? a.targetRoles[0] : '') || 'this field';
  return `Dear Hiring Team,

I'm applying for the ${role} role at ${company}. My background is in ${focus}, with ${years} of hands-on work, and my resume covers the specifics.

I'd welcome the chance to talk about how that fits what your team needs.

Best regards,
${a.fullName}`;
}

// Returns letter text, or null when none should be written.
// `required` decides everything: an optional cover-letter field is left alone.
async function coverLetterFor(a, jobMeta, { required = false } = {}) {
  if (!required) return null;

  const jd = (jobMeta && (jobMeta.description || jobMeta.jobDescription || '')) || '';
  const summary = candidateSummary(a);

  try {
    const prompt = `CANDIDATE PROFILE\n${summary}\n\nJOB POSTING\n${jd || ((jobMeta && jobMeta.role) || 'role') + ' at ' + ((jobMeta && jobMeta.company) || 'company')}\n\nWrite the cover letter.`;
    const text = (await infer({ system: SYSTEM, prompt, model: 'haiku', maxTokens: 700 })).trim();
    // A model that returns something implausibly short or long has not done the job;
    // fall through rather than submit whatever came back.
    if (text.length > 200 && text.length < 3000) return text;
  } catch {
    // fall through to the grounded fallback
  }

  return fallbackLetter(a, jobMeta);
}

module.exports = { coverLetterFor, candidateSummary, fallbackLetter, SYSTEM };
