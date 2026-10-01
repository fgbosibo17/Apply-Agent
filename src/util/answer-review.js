// The last look before submit: read back what is in the form and check it against the
// persona.
//
// WHY A SEPARATE PASS
// Everything before this fills fields one at a time, each decision made without seeing
// the others. `proofread()` catches a handful of known shapes — a city in a non-location
// field, an essay in a yes/no question — but it works field by field too, and it cannot
// tell whether an answer is TRUE of this candidate. Those are different questions:
//
//   proofread     "is this the right SHAPE of answer for this field?"
//   this module   "is this answer true of this persona, and is this form ready to send?"
//
// An application is not undoable. A wrong phone number, the other identity's email, or a
// claim the resume does not support reaches a real employer under the candidate's name and
// stays in their ATS. Ten seconds of checking beats a correction email.
//
// ── TWO LAYERS, AND THE FIRST NEVER NEEDS A MODEL ──────────────────────────
//
//   GROUNDING (always)  Deterministic. Compares identity-bearing fields against the
//                       persona: name, email, phone, LinkedIn, work authorization. These
//                       are the errors that actually happen — the personas share a
//                       surname and two of them share an entire identity, so a stale
//                       value from a previous job is easy to miss and unmistakable to an
//                       employer.
//   REVIEW (when a model is reachable)  Reads every filled answer with the persona's
//                       facts and reports rewrites and unsupported claims.
//
// The model layer is best-effort by design. No backend means the grounding layer still
// runs; it must never be the reason a run stalls. But a BLOCKING finding from either layer
// stops the submit — that is the point of the gate.
const backend = require('../resume/backend');

// labelOf is required lazily. src/util/form.js requires ../answers at module load, which
// throws unless PERSONA is set process-wide — so a top-level require here would make this
// module unimportable outside a configured run, including from a test. The persona arrives
// as an argument; there is no reason to inherit a global.
const labelOf = (el) => require('./form').labelOf(el);

// Layer 2 (the model review) is off while the tailor backend returns HTTP 400 on every
// call. The grounding layer below is deterministic and keeps running; it is the layer that
// catches the errors that actually reach an employer. Set REVIEW_MODEL=1 to turn layer 2
// back on once the backend is fixed.
const REVIEW_MODEL_ON = /^(1|true|yes|on)$/i.test(process.env.REVIEW_MODEL || '');

const MAX_FIELDS = 40;
const MAX_VALUE = 400;

// Identity fields, and how to tell right from wrong for each. Keyed on what the label
// asks for, valued by the persona property that answers it. Whole words only: a bare
// /cell/ matched "ex-CELL-ence" in an essay prompt and replaced the essay with the
// phone number. groundIdentity() also skips essays (textareas, long labels).
const IDENTITY_CHECKS = [
  { what: 'email', label: /\be-?mail\b/i, key: 'email', exact: true },
  { what: 'phone', label: /\b(phone|mobile|cell|cellphone|telephone)\b/i, key: 'phoneDigits', digits: true },
  { what: 'first name', label: /^(legal )?first name|given name|forename/i, key: 'firstName', exact: true },
  { what: 'last name', label: /^(legal )?last name|surname|family name/i, key: 'lastName', exact: true },
  { what: 'full name', label: /^(full|legal) name$|^name$/i, key: 'fullName', exact: true },
  { what: 'LinkedIn', label: /\blinked ?in\b/i, key: 'linkedIn', contains: 'linkedin.com' },
];

const digitsOf = (s) => String(s || '').replace(/\D/g, '');

// Read back every visible, filled field: label, value, kind.
//
// Reading from the DOM rather than from what we believe we typed is the whole value of
// this pass — the form is the thing the employer receives, and an autofill, a react-select
// that reverted, or a field cleared by a re-render is exactly the divergence worth
// catching.
async function harvest(scope) {
  const out = [];
  const els = await scope.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea, select').catch(() => []);
  for (const el of els) {
    if (out.length >= MAX_FIELDS) break;
    if (!(await el.isVisible().catch(() => false))) continue;
    const name = (await el.getAttribute('name').catch(() => '')) || '';
    if (name === 'g-recaptcha-response' || name === 'h-captcha-response') continue;
    const role = await el.evaluate((e) => e.getAttribute('role') || '').catch(() => '');
    const tag = await el.evaluate((e) => e.tagName.toLowerCase()).catch(() => '');
    let value = '';
    if (tag === 'select') {
      value = await el.evaluate((e) => (e.selectedOptions && e.selectedOptions[0] ? e.selectedOptions[0].text : '')).catch(() => '');
    } else {
      value = (await el.inputValue().catch(() => '')) || '';
    }
    if (!String(value).trim()) continue;
    const label = (await labelOf(el).catch(() => '')) || name;
    out.push({
      el,
      label: String(label).replace(/\s+/g, ' ').trim().slice(0, 180),
      value: String(value).slice(0, MAX_VALUE),
      kind: tag === 'select' ? 'select' : (role === 'combobox' ? 'combobox' : tag),
    });
  }
  return out;
}

// Layer 1: does the form say who the persona is?
//
// Only identity-bearing fields, and only where the persona is authoritative. A mismatch
// here is not a style question — it is the wrong person's details on an application.
// An identity field is a short single-line input. A textarea or a long, sentence-length
// label is a question ABOUT something, never the place for an email or phone number.
const IDENTITY_LABEL_MAX = 80;

function groundIdentity(fields, persona) {
  const findings = [];
  for (const f of fields) {
    if (f.kind === 'textarea' || String(f.label || '').length > IDENTITY_LABEL_MAX) continue;
    for (const check of IDENTITY_CHECKS) {
      if (!check.label.test(f.label)) continue;
      const expected = persona[check.key];
      if (!expected) continue;
      const got = f.value.trim();
      let ok;
      if (check.digits) ok = digitsOf(got).endsWith(digitsOf(expected));
      else if (check.contains) ok = got.toLowerCase().includes(check.contains);
      else ok = got.toLowerCase() === String(expected).toLowerCase();

      if (!ok) {
        findings.push({
          layer: 'grounding',
          label: f.label,
          got,
          expected: String(expected),
          what: check.what,
          // Blocking: an employer receiving the wrong identity is not recoverable by a
          // follow-up, and for cloud/fullstack — one identity, two personas — a stale
          // value is genuinely easy to miss.
          blocking: true,
          fix: String(expected),
          reason: `${check.what} does not match the ${persona.persona} persona`,
        });
      }
      break;
    }
  }
  return findings;
}

// The persona's checkable facts, as a compact block for the model. Only what a resume or
// an application would state — no free-text prose to riff on.
function personaFacts(persona) {
  return [
    `name: ${persona.fullName}`,
    `email: ${persona.email}`,
    `phone: ${persona.phoneFull}`,
    `location: ${persona.city}, ${persona.state}, ${persona.country}`,
    `linkedin: ${persona.linkedIn}`,
    `current title: ${persona.currentTitle} at ${persona.currentEmployer}`,
    `total years of experience: ${persona.totalYearsExperience}`,
    `work authorization: ${persona.workAuthStatus} (US citizen: ${persona.usCitizen}; needs sponsorship: ${persona.needsSponsorshipNow})`,
    `willing to relocate: ${persona.willingToRelocate}; work type: ${persona.preferredWorkType}`,
    `notice period: ${persona.noticePeriod}`,
    `salary range: ${persona.salaryRangeString}`,
    persona.elevatorPitch ? `summary: ${persona.elevatorPitch}` : '',
  ].filter(Boolean).join('\n');
}

function buildPrompt(fields, persona, jobMeta) {
  const numbered = fields.map((f, i) => `${i + 1}. [${f.kind}] ${f.label}\n   ANSWER: ${f.value}`).join('\n');
  return [
    'You are reviewing a job application form that has been filled in by an agent, immediately before it is submitted.',
    '',
    'Check each answer against the CANDIDATE FACTS. Report only real problems:',
    '  - a claim not supported by the facts (an employer, title, year count, credential or skill the facts do not state)',
    '  - an answer that contradicts the facts',
    '  - an answer that does not address the question asked',
    '  - a placeholder, a leftover from another question, or obvious junk',
    '',
    'Do NOT report style, length, tone or phrasing. Do NOT suggest embellishment.',
    '',
    'Reply with JSON only, no prose:',
    '{"findings":[{"n":<field number>,"severity":"fix"|"block","reason":"<short>","suggested":"<replacement, or empty if you cannot ground one>"}]}',
    '',
    '"fix" = you have a grounded replacement. "block" = the answer is wrong and you cannot',
    'ground a replacement from the facts, so a human must decide. Empty findings is a valid',
    'and expected answer.',
    '',
    `=== JOB ===\n${(jobMeta && jobMeta.company) || '?'} — ${(jobMeta && jobMeta.role) || '?'}`,
    '',
    `=== CANDIDATE FACTS ===\n${personaFacts(persona)}`,
    '',
    `=== FILLED ANSWERS ===\n${numbered}`,
  ].join('\n');
}

function parseFindings(text, fields) {
  let json = null;
  const raw = String(text || '').trim();
  const m = raw.match(/\{[\s\S]*\}/);
  try { json = JSON.parse(m ? m[0] : raw); } catch { return null; }
  if (!json || !Array.isArray(json.findings)) return [];
  const out = [];
  for (const f of json.findings) {
    const idx = Number(f.n) - 1;
    if (!(idx >= 0 && idx < fields.length)) continue;
    const suggested = typeof f.suggested === 'string' ? f.suggested.trim() : '';
    out.push({
      layer: 'review',
      label: fields[idx].label,
      got: fields[idx].value,
      index: idx,
      reason: String(f.reason || '').slice(0, 200),
      // A finding with no grounded replacement is blocking whatever it claims its
      // severity is: applying nothing and submitting anyway would be the same as not
      // having reviewed.
      blocking: f.severity === 'block' || !suggested,
      fix: suggested,
    });
  }
  return out;
}

// The gate.
//
//   reviewBeforeSubmit(page, scope, { persona, jobMeta })
//     -> { ok, checked, applied, findings, blocking, backend, skipped }
//
// `ok: false` means DO NOT SUBMIT. The caller returns a Skipped result with an attention
// item, exactly as it does for an unavailable email code — the job stays actionable
// instead of being sent wrong or lost.
async function reviewBeforeSubmit(page, scope, { persona, jobMeta = {}, useModel = true } = {}) {
  const fields = await harvest(scope);
  if (!fields.length) {
    return { ok: true, checked: 0, applied: [], findings: [], blocking: [], backend: 'none', skipped: 'no filled fields' };
  }

  // Layer 1 always.
  const findings = groundIdentity(fields, persona);

  // Layer 2 when a model is reachable. Never fatal on its own.
  let backendKind = 'none';
  if (useModel && REVIEW_MODEL_ON) {
    try {
      const chosen = await backend.detect();
      backendKind = chosen.kind;
      if (chosen.available) {
        const res = await backend.tailorOne({
          base: buildPrompt(fields, persona, jobMeta),
          jobDescription: '',
          persona: persona.persona,
        });
        const parsed = parseFindings(res.text, fields);
        if (parsed === null) {
          // Unparseable output is a review that did not happen — not a reason to block a
          // submission the grounding layer is happy with.
          backendKind += ':unparseable';
        } else {
          findings.push(...parsed);
        }
      }
    } catch (e) {
      backendKind = `unavailable (${String(e.message || '').slice(0, 80)})`;
    }
  }

  // Apply what can be grounded; collect what cannot.
  const applied = [];
  const blocking = [];
  for (const f of findings) {
    const target = f.index !== undefined ? fields[f.index] : fields.find((x) => x.label === f.label);
    if (f.fix && target && target.kind !== 'select' && target.kind !== 'combobox') {
      const done = await target.el.fill(String(f.fix)).then(() => true).catch(() => false);
      if (done) { applied.push({ label: f.label, from: f.got, to: f.fix, reason: f.reason, layer: f.layer }); continue; }
    }
    // A select or combobox cannot be corrected by typing, and an ungrounded finding has
    // nothing to type. Both block.
    if (f.blocking || !f.fix) blocking.push({ label: f.label, got: f.got, reason: f.reason, layer: f.layer });
  }

  return {
    ok: blocking.length === 0,
    checked: fields.length,
    applied,
    findings: findings.map((f) => ({ label: f.label, reason: f.reason, layer: f.layer, blocking: !!f.blocking })),
    blocking,
    backend: backendKind,
  };
}

// The handler-facing shape: null to proceed, or a result to return.
//
// Mirrors handleEmailVerification's contract so the six handlers all read the same way.
async function gateBeforeSubmit(page, scope, { persona, jobMeta = {} } = {}) {
  let review;
  try {
    review = await reviewBeforeSubmit(page, scope, { persona, jobMeta });
  } catch (e) {
    // The gate failing is not the form failing. Say so and let the submit proceed rather
    // than losing a good application to a broken reviewer.
    console.log(`    ⚠ pre-submit review errored (${String(e.message || '').slice(0, 80)}) — submitting unreviewed`);
    return null;
  }

  if (review.applied.length) {
    for (const a of review.applied) {
      console.log(`    review fixed [${a.layer}] ${a.label.slice(0, 60)}: "${String(a.from).slice(0, 30)}" -> "${String(a.to).slice(0, 30)}"`);
    }
  }
  if (review.ok) {
    console.log(`    review: ${review.checked} field(s) checked, ${review.applied.length} corrected (${review.backend})`);
    return null;
  }

  const first = review.blocking[0];
  console.log(`    ⚠ review BLOCKED submit: ${first.label.slice(0, 60)} — ${first.reason}`);
  return {
    status: 'Skipped',
    reason: `Pre-submit review blocked: ${first.reason} (${first.label})`.slice(0, 200),
    attention: {
      kind: 'unverifiable-claim',
      severity: 'blocking',
      summary: `Pre-submit review could not ground ${review.blocking.length} answer(s): `
        + review.blocking.map((b) => `"${b.label}" = "${String(b.got).slice(0, 40)}" (${b.reason})`).join('; ').slice(0, 240),
      nextAction: 'Open the job and answer those fields by hand, or correct the persona in src/personas.js if the facts have changed.',
    },
  };
}

module.exports = {
  reviewBeforeSubmit, gateBeforeSubmit, harvest, groundIdentity, personaFacts,
  buildPrompt, parseFindings, IDENTITY_CHECKS,
};
