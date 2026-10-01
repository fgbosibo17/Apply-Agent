// Freshness of sourcing, and the pre-submit review gate.
//
// FRESHNESS. Runs kept landing on "this job posting has expired", from three separate
// causes: RECENT_DAYS defaulted to no cutoff, 71% of queued rows carried no posting date
// so the recency filter never applied to them, and nothing detected expiry at apply time —
// so an expired posting was filled in, failed, and was recorded as a generic error.
//
// REVIEW. An application cannot be recalled. The gate reads the filled form back out of
// the DOM and checks it against the persona before the submit click: identity fields
// always, every answer when a model is reachable.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const { useTempState, resetState } = require('./helpers');

useTempState();

const freshness = require('../src/util/freshness');
const review = require('../src/util/answer-review');
const { personas } = require('../src/personas');

beforeEach(() => { resetState(); });

// ── expiry detection ───────────────────────────────────────────────────────

// A page object exposing only what detectExpired reads.
const fakePage = ({ title = '', body = '', hasForm = false } = {}) => ({
  evaluate: async () => ({ title, head: body, hasForm }),
});

test('the wordings ATSs actually use are detected as expired', async () => {
  const wordings = [
    'This job posting has expired.',
    'We are no longer accepting applications for this position.',
    'This position has been filled.',
    'Sorry, this job is no longer available.',
    'Applications are closed.',
    'This role has been closed.',
    'Job posting not found',
    'This listing has been removed',
  ];
  for (const body of wordings) {
    const r = await freshness.detectExpired(fakePage({ body, hasForm: false }));
    assert.equal(r.expired, true, `should detect: ${body}`);
    assert.ok(r.evidence.length > 0, 'the evidence is quoted, so a skip is auditable');
  }
});

test('a 404 page with no form is treated as removed', async () => {
  const r = await freshness.detectExpired(fakePage({ title: '404 Page Not Found', hasForm: false }));
  assert.equal(r.expired, true);
  assert.equal(r.via, 'not-found-title');
});

// A false positive here silently skips a LIVE job, which is worse than the wasted fill it
// saves. These are the phrases that would trip a naive substring match.
test('a live posting is never called expired', async () => {
  const live = [
    'Senior SDET — Remote. We use a closed-loop testing system.',
    'Apply now. This role is open and we are accepting applications.',
    'You will work on our closed beta product.',
    'Position: Software Engineer. Status: open.',
    'We have filled out our engineering roadmap for the year.',
  ];
  for (const body of live) {
    const r = await freshness.detectExpired(fakePage({ body, hasForm: true }));
    assert.equal(r.expired, false, `must NOT flag: ${body}`);
  }
});

// The strongest wordings are conclusive even when a form is still rendered — some boards
// leave the form up and reject on submit.
test('an unambiguous expiry wins even if a form is still on the page', async () => {
  const conclusive = [
    'This job posting has expired.',
    // This one regressed once: alternation matched the earlier "we are no longer
    // accepting", so testing the matched fragment instead of the page downgraded the
    // strongest signal on it to weak.
    'We are no longer accepting applications for this position.',
    'Sorry, this job is no longer available.',
    'This position has been filled.',
  ];
  for (const body of conclusive) {
    const r = await freshness.detectExpired(fakePage({ body, hasForm: true }));
    assert.equal(r.expired, true, `conclusive even with a form: ${body}`);
  }
});

test('a weaker phrase alongside a live form is not conclusive', async () => {
  const r = await freshness.detectExpired(fakePage({ body: 'This posting is closed to external agencies.', hasForm: true }));
  assert.equal(r.expired, false);
  assert.equal(r.via, 'phrase-but-form-present');
});

test('an unreadable page is not assumed expired', async () => {
  const r = await freshness.detectExpired({ evaluate: async () => { throw new Error('navigating'); } });
  assert.equal(r.expired, false);
  assert.equal(r.via, 'unreadable');
});

// ── queue age ──────────────────────────────────────────────────────────────

const daysAgo = (n) => Date.now() - n * 86400000;

test('age comes from the posting date, or from when we discovered it', () => {
  assert.equal(freshness.ageDays({ posted: daysAgo(10) }), 10);
  assert.equal(freshness.ageDays({ discoveredAt: new Date(daysAgo(3)).toISOString() }), 3);
  // A posting date beats a discovery date: it is the real age.
  assert.equal(freshness.ageDays({ posted: daysAgo(30), discoveredAt: new Date(daysAgo(1)).toISOString() }), 30);
  assert.equal(freshness.ageDays({}), null);
});

test('an undated row is not called stale — we have no evidence either way', () => {
  assert.equal(freshness.isStale({}), false);
  assert.equal(freshness.isStale({ posted: daysAgo(60) }), true);
  assert.equal(freshness.isStale({ posted: daysAgo(2) }), false);
});

// Stale rows are reordered, not dropped: an old posting may still be open, and dropping
// undated rows would empty a queue that is mostly undated.
test('partitioning reports fresh, stale and undated without losing a row', () => {
  const jobs = [
    { url: 'a', posted: daysAgo(1) },
    { url: 'b', posted: daysAgo(40) },
    { url: 'c' },
    { url: 'd', posted: daysAgo(1000) },
  ];
  const p = freshness.partitionByFreshness(jobs, { maxDays: 14 });
  assert.equal(p.fresh.length + p.stale.length, jobs.length, 'nothing is lost');
  assert.deepEqual(p.stale.map((j) => j.url).sort(), ['b', 'd']);
  assert.equal(p.undated, 1);
  assert.ok(p.stale[0].ageDays > 14, 'the age is reported so a skip is explicable');
});

// ── the recency default ────────────────────────────────────────────────────

test('the recency cutoff defaults to a real window, not to off', () => {
  const el = require('../src/util/eligibility');
  assert.ok(el.RECENT_DAYS > 0, 'a default of 0 meant no age filter at all');
  assert.ok(el.RECENT_DAYS <= 60, `${el.RECENT_DAYS}d is too wide to call recent`);
  assert.equal(el.recentEnough(daysAgo(1)), true);
  assert.equal(el.recentEnough(daysAgo(400)), false);
  // Undated still passes, by design — but it is now countable.
  assert.equal(el.recentEnough(null), true);
  assert.equal(el.undated(null), true);
  assert.equal(el.undated(daysAgo(1)), false);
});

// ── the review gate: grounding ─────────────────────────────────────────────

const secondary = personas.secondary;

test('identity fields are checked against the persona', () => {
  const fields = [
    { label: 'Email', value: secondary.email, kind: 'input' },
    { label: 'Phone', value: secondary.phoneFull, kind: 'input' },
    { label: 'First Name', value: secondary.firstName, kind: 'input' },
    { label: 'LinkedIn Profile', value: secondary.linkedIn, kind: 'input' },
  ];
  assert.deepEqual(review.groundIdentity(fields, secondary), [], 'a correct form has no findings');
});

// The failure that actually happens: primary and adjacent are ONE identity and all three
// personas share a surname, so a stale value from a previous job is easy to miss and
// unmistakable to an employer.
test('the other identity\'s email is caught and blocks', () => {
  const fields = [{ label: 'Email', value: personas.primary.email, kind: 'input' }];
  const found = review.groundIdentity(fields, secondary);
  assert.equal(found.length, 1);
  assert.equal(found[0].what, 'email');
  assert.equal(found[0].blocking, true);
  assert.equal(found[0].fix, secondary.email, 'and it knows the right answer');
  assert.match(found[0].reason, /does not match the secondary persona/);
});

test('a wrong phone is caught, and formatting differences are not', () => {
  // Derived from the persona, never hardcoded: these fixtures get copied to the public
  // template by scripts/sync-template.js, and a literal here would be real PII there.
  const d = secondary.phoneDigits;
  const pretty = `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  assert.equal(review.groundIdentity([{ label: 'Phone', value: pretty, kind: 'input' }], secondary).length, 0);
  assert.equal(review.groundIdentity([{ label: 'Mobile phone', value: d, kind: 'input' }], secondary).length, 0);
  assert.equal(review.groundIdentity([{ label: 'Phone', value: '555-000-1234', kind: 'input' }], secondary).length, 1);
});

test('non-identity fields are left alone by the grounding layer', () => {
  const fields = [
    { label: 'Why do you want to work here?', value: 'Because I like testing.', kind: 'textarea' },
    { label: 'Years of experience', value: '9', kind: 'input' },
  ];
  assert.deepEqual(review.groundIdentity(fields, secondary), []);
});

// ── the review gate: the model layer ───────────────────────────────────────

test('the prompt carries the persona facts and forbids embellishment', () => {
  const fields = [{ label: 'Tell us about your experience', value: 'I have 20 years at Google.', kind: 'textarea' }];
  const p = review.buildPrompt(fields, secondary, { company: 'Acme', role: 'SDET' });
  assert.match(p, /=== CANDIDATE FACTS ===/);
  assert.match(p, new RegExp(secondary.email));
  assert.match(p, new RegExp(`total years of experience: ${secondary.totalYearsExperience}`));
  assert.match(p, /work authorization/);
  assert.match(p, /Do NOT suggest embellishment/);
  assert.match(p, /=== FILLED ANSWERS ===/);
  assert.match(p, /I have 20 years at Google/);
  assert.match(p, /Acme — SDET/);
});

test('model findings are parsed and mapped back to their field', () => {
  const fields = [
    { label: 'Experience', value: 'I have 20 years at Google.', kind: 'textarea' },
    { label: 'Notice period', value: '2 weeks', kind: 'input' },
  ];
  const parsed = review.parseFindings(JSON.stringify({
    findings: [{ n: 1, severity: 'fix', reason: 'facts state 9 years, not 20, and no Google', suggested: 'I have 9 years across healthcare and SaaS.' }],
  }), fields);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].index, 0);
  assert.equal(parsed[0].blocking, false, 'a grounded replacement is applied, not blocked');
  assert.match(parsed[0].fix, /9 years/);
});

// A finding with no grounded replacement must block: applying nothing and submitting
// anyway is the same as not having reviewed.
test('a finding with no suggestion blocks even when marked fix', () => {
  const fields = [{ label: 'Security clearance level', value: 'Top Secret', kind: 'input' }];
  const parsed = review.parseFindings(JSON.stringify({
    findings: [{ n: 1, severity: 'fix', reason: 'the facts state no clearance', suggested: '' }],
  }), fields);
  assert.equal(parsed[0].blocking, true);
});

test('a block severity blocks', () => {
  const fields = [{ label: 'Q', value: 'v', kind: 'input' }];
  const parsed = review.parseFindings(JSON.stringify({ findings: [{ n: 1, severity: 'block', reason: 'unverifiable' }] }), fields);
  assert.equal(parsed[0].blocking, true);
});

test('unparseable model output is distinguished from no findings', () => {
  const fields = [{ label: 'Q', value: 'v', kind: 'input' }];
  assert.equal(review.parseFindings('I could not review that.', fields), null);
  assert.deepEqual(review.parseFindings(JSON.stringify({ findings: [] }), fields), []);
});

test('a finding naming a field that does not exist is ignored', () => {
  const fields = [{ label: 'Q', value: 'v', kind: 'input' }];
  assert.deepEqual(review.parseFindings(JSON.stringify({ findings: [{ n: 99, severity: 'block', reason: 'x' }] }), fields), []);
});

// ── the gate end to end, against a fake form ───────────────────────────────

// A scope exposing only what harvest() reads, plus a fill() that records writes.
function fakeForm(fields) {
  const writes = [];
  const els = fields.map((f) => ({
    isVisible: async () => f.visible !== false,
    getAttribute: async (n) => (n === 'name' ? (f.name || '') : null),
    evaluate: async (fn) => {
      const src = String(fn);
      if (src.includes('tagName')) return f.tag || 'input';
      if (src.includes('selectedOptions')) return f.value;
      return '';
    },
    inputValue: async () => f.value,
    fill: async (v) => { writes.push({ label: f.label, to: v }); f.value = v; },
    _label: f.label,
  }));
  return {
    writes,
    scope: { $$: async () => els },
  };
}

// labelOf reads the real DOM, so stub it for the fake form. answer-review requires it
// lazily precisely so this is possible without a configured PERSONA.
const withStubbedLabels = async (fn) => {
  process.env.PERSONA = process.env.PERSONA || 'secondary';
  const form = require('../src/util/form');
  const original = form.labelOf;
  form.labelOf = async (el) => el._label || '';
  try { return await fn(); } finally { form.labelOf = original; }
};

test('a clean form passes the gate with no model available', async () => {
  await withStubbedLabels(async () => {
    const f = fakeForm([
      { label: 'Email', value: secondary.email },
      { label: 'First Name', value: secondary.firstName },
    ]);
    const res = await review.reviewBeforeSubmit({}, f.scope, { persona: secondary, useModel: false });
    assert.equal(res.ok, true);
    assert.equal(res.checked, 2);
    assert.equal(res.blocking.length, 0);
    assert.equal(f.writes.length, 0, 'a correct form is not rewritten');
  });
});

test('a wrong identity value is corrected in place, and the submit proceeds', async () => {
  await withStubbedLabels(async () => {
    const f = fakeForm([{ label: 'Email', value: personas.primary.email }]);
    const res = await review.reviewBeforeSubmit({}, f.scope, { persona: secondary, useModel: false });
    assert.equal(res.ok, true, 'grounded, so fixed rather than blocked');
    assert.equal(res.applied.length, 1);
    assert.equal(f.writes[0].to, secondary.email, 'the form now holds the right address');
  });
});

test('gateBeforeSubmit returns null to proceed and a Skipped result to block', async () => {
  await withStubbedLabels(async () => {
    const clean = fakeForm([{ label: 'Email', value: secondary.email }]);
    assert.equal(await review.gateBeforeSubmit({}, clean.scope, { persona: secondary }), null);
  });
});

test('an empty form is not blocked by the gate', async () => {
  await withStubbedLabels(async () => {
    const res = await review.reviewBeforeSubmit({}, fakeForm([]).scope, { persona: secondary, useModel: false });
    assert.equal(res.ok, true);
    assert.equal(res.checked, 0);
    assert.equal(res.skipped, 'no filled fields');
  });
});

// The gate is a safety check, not a dependency. A broken reviewer must not cost a good
// application.
test('a reviewer that throws lets the submit through rather than losing the application', async () => {
  const exploding = { $$: async () => { throw new Error('DOM went away'); } };
  const res = await review.gateBeforeSubmit({}, exploding, { persona: secondary });
  assert.equal(res, null, 'proceed, unreviewed, with a note');
});

// ── wiring ─────────────────────────────────────────────────────────────────

test('every dispatched ATS handler runs the gate before submitting', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '..');
  for (const h of ['greenhouse', 'ashby', 'lever', 'workable', 'smartrecruiters']) {
    const src = fs.readFileSync(path.join(root, 'src/ats', `${h}.js`), 'utf8');
    assert.match(src, /gateBeforeSubmit/, `${h} must run the pre-submit review`);
    assert.match(src, /if \(reviewBlock\) return reviewBlock;/, `${h} must honour a block`);
  }
});

test('the runner checks for an expired posting before dispatching a handler', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/index.js'), 'utf8');
  assert.match(src, /detectExpired\(page\)/);
  assert.match(src, /action: 'Expired'/, 'recorded as expired, not as a generic error');
  assert.match(src, /partitionByFreshness/, 'and queue age is reported up front');
});

test('discovery stamps when a row was found and whether its date was known', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/discover-api.js'), 'utf8');
  assert.match(src, /discoveredAt:/);
  assert.match(src, /postedUnknown:/);
});
