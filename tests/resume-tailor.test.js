// Resume tailoring: opt-in, batch, and never load-bearing.
//
// The properties worth protecting, in order of how much damage their absence causes:
//
//   1. OFF BY DEFAULT. No flag means no model call and no tailored writes.
//   2. NEVER FAILS A RUN. No backend, no base text, a model error, a bad render — every
//      one of them falls back to the base resume and carries on. An unavailable model
//      must not cost an evening's applications.
//   3. THE LEDGER KNOWS WHICH FILE WENT. Tailored hash, or 'base'. Otherwise "what did
//      this employer see?" is unanswerable once the PDF is GC'd.
//   4. SOURCES ARE PERMANENT, RENDERS ARE NOT. gc deletes PDFs and never sources.
//
// The model and the browser are injected: CI has neither a claude login nor Chrome, and
// a pass testable only on a laptop would not be tested.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const { useTempState, resetState } = require('./helpers');

useTempState();

const tailor = require('../src/resume/tailor');
const manifest = require('../src/resume/manifest');
const { resolveResume, findSource } = require('../src/resume/resolve');
const render = require('../src/resume/render');
const baseText = require('../src/resume/base-text');
const backend = require('../src/resume/backend');
const paths = require('../src/core/paths');
const ledger = require('../src/core/ledger');
const queues = require('../src/core/queues');
const machine = require('../src/core/machine');

beforeEach(() => {
  resetState();
  machine.reset();
  backend.reset();
  require('../src/core/config').reset();
});

const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const ROUND = 'rnd_20260901_test';

// A base resume long enough to pass the plausibility checks.
const BASE_TEXT = [
  'JANE DOE',
  '+1 555-010-0000 | candidate@example.com',   // placeholder: this file is published
  'PROFESSIONAL SUMMARY',
  'Automation Architect and SDET with eight years building enterprise quality ecosystems',
  'across healthcare and SaaS, specialising in Playwright, Cypress and containerised',
  'continuous integration pipelines that keep regression suites fast and trustworthy.',
  'EXPERIENCE',
  'QA Automation Engineer, Acme Health, 2022 to present',
  'Built agentic test generation and self healing locators for a large regression suite.',
  'Reduced flake and cut the regression window from six hours to under ninety minutes.',
  'Senior QA Engineer, Globex Foods, 2019 to 2022',
  'Migrated a legacy Selenium suite to Cypress and introduced quality gates in delivery.',
  'SKILLS',
  'Playwright, Cypress, Selenium, JavaScript, TypeScript, Docker, AWS, Azure, Jenkins.',
].join('\n');

const persona = (over = {}) => ({
  persona: 'secondary',
  fullName: 'Jane Doe',
  resumePath: path.join(paths.stateDir(), 'base-qa.pdf'),
  ...over,
});
function withBasePdf(p) {
  fs.writeFileSync(p.resumePath, PDF);
  return p;
}

const jobs = (n = 2) => Array.from({ length: n }, (_, i) => ({
  url: `https://boards.greenhouse.io/acme/jobs/${100 + i}`,
  company: `Acme${i}`,
  role: 'Senior SDET',
  description: 'We are hiring a Senior SDET to own Playwright end-to-end coverage, build '
    + 'quality gates into CI, and reduce flake across a large regression suite. '
    + 'You will work with Docker, AWS and Jenkins. Cypress experience is a plus.',
}));

// ── stub dependencies ──────────────────────────────────────────────────────

const stubBackend = (impl = {}) => ({
  detect: async () => impl.detect || { kind: 'stub', available: true, detail: 'stub backend' },
  tailorOne: impl.tailorOne || (async ({ base }) => ({
    text: `# Jane Doe\n\n## Summary\n\nTailored for this posting.\n\n${base}`,
    backend: 'stub',
  })),
});
const stubBaseText = (text = BASE_TEXT) => ({
  extract: () => (text
    ? { ok: true, text, source: 'stub', cached: false, detail: 'stub' }
    : { ok: false, text: '', source: null, cached: false, detail: 'no base text available' }),
});
// Writes a real (tiny) PDF so verification and gc operate on actual files.
const stubRender = (impl = {}) => ({
  pageGeometry: () => ({ format: 'Letter', widthIn: 8.5, heightIn: 11, source: 'stub', margin: 0.5 }),
  openRenderer: impl.openRenderer || (async () => ({
    render: impl.render || (async (md, outPath) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, PDF + `\n% ${md.length} chars\n`);
      return { ok: true, bytes: fs.statSync(outPath).size, path: outPath };
    }),
    close: async () => {},
  })),
});
const deps = (over = {}) => ({
  backend: over.backend || stubBackend(),
  baseText: over.baseText || stubBaseText(),
  render: over.render || stubRender(),
});

// ── 1. the happy path ──────────────────────────────────────────────────────

test('a batch pass tailors every job, storing source and render', async () => {
  const p = withBasePdf(persona());
  const rep = await tailor.tailorQueue({ jobs: jobs(2), persona: p, roundId: ROUND, deps: deps() });

  assert.equal(rep.accepted, 2);
  assert.equal(rep.rejected, 0);
  assert.equal(rep.fallback, 0);

  const rows = manifest.all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.status, 'accepted');
    assert.ok(row.baseHash, 'the base it tailored from is recorded');
    assert.ok(row.tailoredHash, 'the document produced is recorded');
    assert.ok(fs.existsSync(row.sourcePath), 'the markdown source is on disk');
    assert.ok(fs.existsSync(row.renderPath), 'the rendered PDF is on disk');
    assert.match(row.sourcePath, /tailored[\\/]rnd_20260901_test[\\/]job_[0-9a-f]+\.md$/);
    assert.equal(row.machineId, machine.id());
  }
});

test('the resolver returns the tailored PDF for a tailored job and base for others', async () => {
  const p = withBasePdf(persona());
  const list = jobs(1);
  await tailor.tailorQueue({ jobs: list, persona: p, roundId: ROUND, deps: deps() });

  const hit = resolveResume({ persona: p, url: list[0].url, roundId: ROUND });
  assert.notEqual(hit.path, p.resumePath);
  assert.match(hit.path, /\.pdf$/);
  assert.notEqual(hit.variant, 'base');
  assert.equal(hit.variant, manifest.latestFor({ jobId: hit.jobId }).tailoredHash);

  const miss = resolveResume({ persona: p, url: 'https://boards.greenhouse.io/other/jobs/9', roundId: ROUND });
  assert.equal(miss.path, p.resumePath);
  assert.equal(miss.variant, 'base');
  assert.match(miss.reason, /no accepted tailored resume/);
});

test('a second pass over the same round reuses what it already tailored', async () => {
  const p = withBasePdf(persona());
  const list = jobs(1);
  let calls = 0;
  const counting = deps({ backend: stubBackend({ tailorOne: async () => { calls += 1; return { text: `# Jane Doe\n\n${BASE_TEXT}`, backend: 'stub' }; } }) });

  await tailor.tailorQueue({ jobs: list, persona: p, roundId: ROUND, deps: counting });
  await tailor.tailorQueue({ jobs: list, persona: p, roundId: ROUND, deps: counting });
  assert.equal(calls, 1, 'the model is not paid twice for the same document');
});

// ── 2. every failure falls back, none of them throw ────────────────────────

test('no model backend: all fallback, base resumes, friction recorded, no throw', async () => {
  const p = withBasePdf(persona());
  const rep = await tailor.tailorQueue({
    jobs: jobs(3), persona: p, roundId: ROUND,
    deps: deps({ backend: { detect: async () => ({ kind: 'none', available: false, detail: 'no claude CLI and no endpoint' }) } }),
  });

  assert.equal(rep.fallback, 3);
  assert.equal(rep.accepted, 0);
  assert.equal(manifest.all().length, 3, 'the attempt is still recorded');
  assert.ok(manifest.all().every((r) => r.status === 'fallback'));
  assert.ok(queues.frictionList().some((f) => f.area === 'resume:tailor'));

  // And the resolver hands back base for every one of them.
  for (const j of jobs(3)) {
    assert.equal(resolveResume({ persona: p, url: j.url, roundId: ROUND }).variant, 'base');
  }
});

test('no base resume text: fallback rather than tailoring from nothing', async () => {
  const p = withBasePdf(persona());
  const rep = await tailor.tailorQueue({
    jobs: jobs(2), persona: p, roundId: ROUND, deps: deps({ baseText: stubBaseText(null) }),
  });
  assert.equal(rep.fallback, 2);
  assert.match(Object.keys(rep.reasons).join(' '), /no base resume text/);
});

test('a model error on one job does not stop the batch', async () => {
  const p = withBasePdf(persona());
  let n = 0;
  const flaky = stubBackend({
    tailorOne: async () => {
      n += 1;
      if (n === 2) throw new Error('endpoint timed out after 180000ms');
      return { text: `# Jane Doe\n\n## Summary\n\n${BASE_TEXT}`, backend: 'stub' };
    },
  });
  const rep = await tailor.tailorQueue({ jobs: jobs(3), persona: p, roundId: ROUND, deps: deps({ backend: flaky }) });
  assert.equal(rep.accepted, 2);
  assert.equal(rep.fallback, 1);
  const failed = manifest.all().find((r) => r.status === 'fallback');
  assert.match(failed.verdict, /timed out/);
});

test('a render failure keeps the source and falls back to base', async () => {
  const p = withBasePdf(persona());
  const rep = await tailor.tailorQueue({
    jobs: jobs(1), persona: p, roundId: ROUND,
    deps: deps({ render: stubRender({ render: async () => { throw new Error('Chrome would not start'); } }) }),
  });
  assert.equal(rep.fallback, 1);
  const row = manifest.all()[0];
  assert.equal(row.status, 'fallback');
  assert.match(row.verdict, /render failed/);
  assert.ok(fs.existsSync(row.sourcePath), 'the source survives a failed render, so it can be re-rendered');
  assert.equal(resolveResume({ persona: p, url: jobs(1)[0].url, roundId: ROUND }).variant, 'base');
});

test('an unlaunchable renderer skips the model entirely', async () => {
  const p = withBasePdf(persona());
  let called = false;
  const rep = await tailor.tailorQueue({
    jobs: jobs(2), persona: p, roundId: ROUND,
    deps: deps({
      backend: stubBackend({ tailorOne: async () => { called = true; return { text: 'x', backend: 'stub' }; } }),
      render: stubRender({ openRenderer: async () => { throw new Error('no Chrome'); } }),
    }),
  });
  assert.equal(rep.fallback, 2);
  assert.equal(called, false, 'nothing to render means nothing worth generating');
});

test('a job with no captured description is not tailored to nothing', async () => {
  const p = withBasePdf(persona());
  const rep = await tailor.tailorQueue({
    jobs: [{ url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme', description: '' }],
    persona: p, roundId: ROUND, deps: deps(),
  });
  assert.equal(rep.fallback, 1);
  assert.match(manifest.all()[0].verdict, /no job description/);
});

test('no round id means no tailoring at all', async () => {
  const rep = await tailor.tailorQueue({ jobs: jobs(2), persona: withBasePdf(persona()), roundId: '', deps: deps() });
  assert.equal(rep.skipped, 2);
  assert.equal(manifest.all().length, 0);
});

// ── 3. mechanical acceptance ───────────────────────────────────────────────

test('unusable model output is rejected, and the document is kept for diagnosis', async () => {
  const cases = [
    ['', 'empty output'],
    ['# Jane Doe\n\ntoo short', 'too short'],
    [`# Someone Else\n\n## Summary\n\n${'Experienced engineer delivering quality software. '.repeat(20)}`, 'candidate name'],
    [`I'm sorry, I cannot help with that request. ${'x'.repeat(500)}`, 'declined'],
  ];
  for (const [text, expect] of cases) {
    const v = tailor.assess(text, { base: BASE_TEXT, fullName: 'Jane Doe' });
    assert.equal(v.ok, false, `should reject: ${expect}`);
    assert.match(v.verdict, new RegExp(expect, 'i'));
  }
});

test('a rejected document still writes its source but never uploads', async () => {
  const p = withBasePdf(persona());
  const rep = await tailor.tailorQueue({
    jobs: jobs(1), persona: p, roundId: ROUND,
    deps: deps({ backend: stubBackend({ tailorOne: async () => ({ text: '# Wrong Person\n\n## Summary\n\n' + 'Experienced engineer delivering quality software. '.repeat(20), backend: 'stub' }) }) }),
  });
  assert.equal(rep.rejected, 1);
  const row = manifest.all()[0];
  assert.equal(row.status, 'rejected');
  assert.ok(fs.existsSync(row.sourcePath));
  assert.equal(row.renderPath, '', 'a rejected document is never rendered');
  assert.equal(resolveResume({ persona: p, url: jobs(1)[0].url, roundId: ROUND }).variant, 'base');
});

test('output plausibly derived from the base is accepted', () => {
  const good = `# Jane Doe\n\n## Summary\n\nSDET focused on Playwright.\n\n${BASE_TEXT}`;
  const v = tailor.assess(good, { base: BASE_TEXT, fullName: 'Jane Doe' });
  assert.equal(v.ok, true);
});

// ── 4. retention: sources permanent, renders disposable ────────────────────

test('gc deletes rendered PDFs past retention and never touches sources', async () => {
  const p = withBasePdf(persona());
  await tailor.tailorQueue({ jobs: jobs(2), persona: p, roundId: ROUND, deps: deps() });
  const rows = manifest.all();
  // Age both renders past the window.
  const old = new Date(Date.now() - 40 * 86400000);
  for (const r of rows) fs.utimesSync(r.renderPath, old, old);

  const res = tailor.gc({ retentionDays: 30 });
  assert.equal(res.deletedRenders, 2);
  assert.ok(res.reclaimedBytes > 0);
  for (const r of rows) {
    assert.equal(fs.existsSync(r.renderPath), false, 'the PDF is gone');
    assert.equal(fs.existsSync(r.sourcePath), true, 'the source is permanent');
  }
  assert.equal(res.keptSources, 2);
  assert.match(res.note, /regenerate/);
});

test('gc leaves renders inside the window alone', async () => {
  const p = withBasePdf(persona());
  await tailor.tailorQueue({ jobs: jobs(1), persona: p, roundId: ROUND, deps: deps() });
  const res = tailor.gc({ retentionDays: 30 });
  assert.equal(res.deletedRenders, 0);
  assert.ok(fs.existsSync(manifest.all()[0].renderPath));
});

test('gc --dry-run reports without deleting', async () => {
  const p = withBasePdf(persona());
  await tailor.tailorQueue({ jobs: jobs(1), persona: p, roundId: ROUND, deps: deps() });
  const row = manifest.all()[0];
  const old = new Date(Date.now() - 40 * 86400000);
  fs.utimesSync(row.renderPath, old, old);

  const res = tailor.gc({ retentionDays: 30, dryRun: true });
  assert.equal(res.deletedRenders, 1);
  assert.equal(fs.existsSync(row.renderPath), true, 'dry run must not delete');
});

// The reason sources are permanent: after gc, the resolver must fall back rather than
// hand a nonexistent path to a file input.
test('a GC-d render falls back to base until it is re-rendered', async () => {
  const p = withBasePdf(persona());
  const list = jobs(1);
  await tailor.tailorQueue({ jobs: list, persona: p, roundId: ROUND, deps: deps() });
  assert.notEqual(resolveResume({ persona: p, url: list[0].url, roundId: ROUND }).variant, 'base');

  fs.rmSync(manifest.all()[0].renderPath, { force: true });
  const after = resolveResume({ persona: p, url: list[0].url, roundId: ROUND });
  assert.equal(after.variant, 'base');
  assert.equal(after.path, p.resumePath);
});

test('a stored source is findable months later, whatever happened to the PDF', async () => {
  const p = withBasePdf(persona());
  const list = jobs(1);
  await tailor.tailorQueue({ jobs: list, persona: p, roundId: ROUND, deps: deps() });
  const jobId = manifest.jobIdFor(list[0].url);
  fs.rmSync(manifest.all()[0].renderPath, { force: true });

  const src = findSource(jobId);
  assert.ok(src, 'the permanent record survives');
  assert.ok(fs.existsSync(src.sourcePath));
  assert.match(fs.readFileSync(src.sourcePath, 'utf8'), /Jane Doe/);
});

// ── 5. the ledger records which file went ──────────────────────────────────

test('a ledger entry records the tailored hash, or base on fallback', () => {
  const tailored = ledger.add({
    url: 'https://boards.greenhouse.io/acme/jobs/1', confirmation: 'received', resumeVariant: 'abc123def456',
  });
  assert.equal(tailored.resumeVariant, 'abc123def456');
  const plain = ledger.add({ url: 'https://boards.greenhouse.io/acme/jobs/2', confirmation: 'received' });
  assert.equal(plain.resumeVariant, 'base', 'unset means base — never an empty field');
});

// ── 6. job ids are stable ──────────────────────────────────────────────────

test('a job id is stable across cosmetic URL differences and across machines', () => {
  const a = manifest.jobIdFor('https://boards.greenhouse.io/acme/jobs/12345?utm_source=x');
  const b = manifest.jobIdFor('https://boards.greenhouse.io/acme/jobs/12345#apply');
  assert.equal(a, b, 'the same posting must map to the same stored file');
  assert.match(a, /^job_[0-9a-f]{12}$/);
  assert.notEqual(a, manifest.jobIdFor('https://boards.greenhouse.io/acme/jobs/99999'));
});

// ── 7. markdown rendering, and page geometry from the base ─────────────────

test('markdown becomes the HTML a resume needs', () => {
  const html = render.markdownToHtml([
    '# Jane Doe',
    '## Experience',
    '### SDET — Acme Health',
    '- Built **Playwright** suites',
    '- Cut regression by 60%',
    '',
    'Plain paragraph with [a link](https://example.com).',
    '---',
  ].join('\n'));
  assert.match(html, /<h1>Jane Doe<\/h1>/);
  assert.match(html, /<h3>SDET — Acme Health<\/h3>/);
  assert.match(html, /<ul>[\s\S]*<li>Built <strong>Playwright<\/strong> suites<\/li>/);
  assert.match(html, /<a href="https:\/\/example\.com">a link<\/a>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<p>Plain paragraph/);
});

test('markdown is escaped, so a stray angle bracket cannot break the document', () => {
  const html = render.markdownToHtml('Reduced flake <50% & improved speed');
  assert.match(html, /&lt;50% &amp; improved/);
  assert.doesNotMatch(html, /<50%/);
});

test('page size is read from the base resume so the tailored one matches', () => {
  const letter = path.join(paths.stateDir(), 'letter.pdf');
  fs.writeFileSync(letter, '%PDF-1.4\n1 0 obj<</Type/Page /MediaBox [0 0 612 792]>>endobj\n');
  const g1 = render.pageGeometry(letter);
  assert.equal(g1.format, 'Letter');
  assert.equal(g1.source, 'base-mediabox');

  const a4 = path.join(paths.stateDir(), 'a4.pdf');
  fs.writeFileSync(a4, '%PDF-1.4\n1 0 obj<</Type/Page /MediaBox [0 0 595 842]>>endobj\n');
  assert.equal(render.pageGeometry(a4).format, 'A4');

  // An unreadable or absent base still yields a usable geometry rather than throwing.
  const missing = render.pageGeometry(path.join(paths.stateDir(), 'nope.pdf'));
  assert.equal(missing.source, 'default');
  assert.equal(missing.format, 'Letter');
});

// ── 8. base text extraction ────────────────────────────────────────────────

// The guard that matters: `textutil -convert txt` on a PDF returns the PDF's own bytes,
// which passes any length check. Feeding that to a model produces a resume built from
// PDF object dictionaries.
test('PDF internals are never accepted as extracted resume text', () => {
  const pdfish = '%PDF-1.4\n' + '1 0 obj<</Type/Catalog /Producer (Skia/PDF)>>endobj\n'.repeat(40) + 'xref\ntrailer\n';
  assert.equal(baseText.looksLikeProse(pdfish), false);
  assert.equal(baseText.looksLikeProse(BASE_TEXT), true);
  assert.equal(baseText.looksLikeProse('too short'), false);
  assert.equal(baseText.looksLikeProse('\u0000\u0001\u0002'.repeat(200)), false);
});

test('extracted base text is cached per persona, so extraction runs once', () => {
  const p = persona({ resumePath: path.join(paths.stateDir(), 'nonexistent.pdf') });
  fs.writeFileSync(paths.resumeBaseText('secondary'), BASE_TEXT, { mode: 0o600 });
  const r = baseText.extract(p);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'cache');
  assert.equal(r.cached, true);
});

test('a markdown sidecar beside the resume is preferred', () => {
  const resumePath = path.join(paths.stateDir(), 'Sidecar_Resume.pdf');
  fs.writeFileSync(resumePath, PDF);
  fs.writeFileSync(resumePath.replace(/\.pdf$/, '.md'), BASE_TEXT);
  const r = baseText.extract(persona({ persona: 'sidecartest', resumePath }));
  assert.equal(r.source, 'sidecar');
  assert.match(r.text, /JANE DOE/);
});

// ── 9. the real repo's base resumes ────────────────────────────────────────

// A .docx is a ZIP of XML, inflatable with node:zlib and no dependency. These files use
// streamed entries, so the central directory is the only way in.
test('the real persona resumes extract via the docx route', () => {
  const { personas } = require('../src/personas');
  for (const [key, p] of Object.entries(personas)) {
    if (!p.resumeDocx || !fs.existsSync(p.resumeDocx)) continue;
    const text = baseText.fromDocx(p.resumeDocx);
    assert.ok(text, `${key}: expected text from ${path.basename(p.resumeDocx)}`);
    assert.ok(text.length > 1000, `${key}: only ${text ? text.length : 0} chars`);
    const surname = p.fullName.split(' ').slice(-1)[0];
    assert.match(text, new RegExp(surname, 'i'), `${key}: the candidate's name should appear`);
  }
});

// ── 10. the model backend, without calling a model ─────────────────────────

test('an endpoint is preferred over the CLI when configured', async () => {
  const prev = process.env.APPLY_AGENT_TAILOR_ENDPOINT;
  process.env.APPLY_AGENT_TAILOR_ENDPOINT = 'https://orchestrator.example/tailor';
  backend.reset();
  try {
    const d = await backend.detect();
    assert.equal(d.kind, 'endpoint');
    assert.equal(d.available, true);
    assert.match(d.detail, /orchestrator\.example/);
  } finally {
    if (prev === undefined) delete process.env.APPLY_AGENT_TAILOR_ENDPOINT;
    else process.env.APPLY_AGENT_TAILOR_ENDPOINT = prev;
    backend.reset();
  }
});

test('a missing endpoint and a missing CLI is reported as unavailable, not thrown', async () => {
  const prevBin = process.env.CLAUDE_BIN;
  const prevEp = process.env.APPLY_AGENT_TAILOR_ENDPOINT;
  delete process.env.APPLY_AGENT_TAILOR_ENDPOINT;
  process.env.CLAUDE_BIN = path.join(paths.stateDir(), 'definitely-not-a-binary');
  backend.reset();
  try {
    const d = await backend.detect();
    assert.equal(d.available, false);
    assert.equal(d.kind, 'none');
    assert.match(d.detail, /no claude CLI/);
  } finally {
    if (prevBin === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = prevBin;
    if (prevEp !== undefined) process.env.APPLY_AGENT_TAILOR_ENDPOINT = prevEp;
    backend.reset();
  }
});

test('the prompt tells the model to work only from the base', () => {
  const prompt = backend.buildPrompt({ base: BASE_TEXT, jobDescription: 'Senior SDET wanted', persona: 'secondary' });
  assert.match(prompt, /Do not add an employer, job title, date/);
  assert.match(prompt, /reorder sections and bullets/i);
  assert.match(prompt, /=== BASE RESUME ===/);
  assert.match(prompt, /=== JOB POSTING ===/);
  assert.match(prompt, /Senior SDET wanted/);
});

test('a fenced document is unwrapped', () => {
  assert.equal(backend.stripFences('```markdown\n# Name\n\nbody\n```'), '# Name\n\nbody');
  assert.equal(backend.stripFences('# Name\n\nbody'), '# Name\n\nbody');
});
