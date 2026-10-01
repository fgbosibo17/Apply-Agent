// The tailoring batch pass: after discovery, before applying, over the whole queue.
//
// WHY A BATCH PASS AND NOT PER JOB
// Tailoring inside the browser loop would put a model call between opening a form and
// submitting it. Two consequences, both bad:
//
//   * every application waits on inference, so a 40-job run gains 40 model latencies
//     while a warm Chrome session sits idle — and that session degrades with age,
//     which is the whole reason run-loop.js batches with a fresh browser.
//   * a model outage mid-run strands a browser on a half-filled form. An outage
//     between passes costs nothing: the run continues with base resumes.
//
// So: resolve every resume up front, write the results down, then apply. By the time a
// browser opens, every job already knows which file it is uploading.
//
// OPT-IN. Tailoring is off unless asked for. When off this module is not even called —
// no model call, no writes, no rendered PDFs. Base resumes upload exactly as before.
const fs = require('fs');

const paths = require('../core/paths');
const queues = require('../core/queues');
const backend = require('./backend');
const baseText = require('./base-text');
const render = require('./render');
const manifest = require('./manifest');
const { verifyResumeFile } = require('./verify');

// Mechanical acceptance checks. Not a model review — just "is this a resume-shaped
// document that still describes this candidate?". A model that returns an apology, a
// truncated fragment, or a document with the wrong name on it is caught here.
function assess(tailored, { base, fullName }) {
  const t = (tailored || '').trim();
  if (!t) return { ok: false, verdict: 'empty output' };
  // Checked before the shape rules: "the model declined" is a precise, actionable
  // diagnosis, and a refusal would otherwise be reported as whichever structural rule
  // it happened to trip first.
  if (/^(i'm sorry|i am sorry|i cannot|i can't|as an ai|unfortunately, i)/i.test(t)) {
    return { ok: false, verdict: 'model declined the request' };
  }
  if (t.length < 400) return { ok: false, verdict: `too short (${t.length} chars)` };
  // Wildly longer than the base means it padded rather than tailored.
  if (base && t.length > base.length * 2.5) {
    return { ok: false, verdict: `implausibly long (${t.length} vs base ${base.length})` };
  }
  // The candidate's surname must survive. Losing it means the document is not theirs.
  if (fullName) {
    const surname = String(fullName).trim().split(/\s+/).slice(-1)[0];
    if (surname.length > 2 && !new RegExp(surname, 'i').test(t)) {
      return { ok: false, verdict: `candidate name "${surname}" missing from output` };
    }
  }
  return { ok: true, verdict: 'accepted' };
}

const friction = (summary, signature) => {
  try {
    queues.frictionRecord({ area: 'resume:tailor', reproducible: false, summary, signature });
  } catch { /* friction is a diagnostic, never a failure */ }
};

// Run the pass.
//
//   tailorQueue({ jobs, persona, roundId, dryRun })
//
// `jobs` is the queue: [{ url, company, role, description|jd }]. Returns a report; it
// throws only on programmer error, never on an unavailable model — an outage produces
// a report full of `fallback` rows and the run carries on.
// `deps` exists so tests can drive the pass without a model or a browser: CI has
// neither a claude login nor Chrome installed, and a pass that could only be tested on
// a developer laptop would not be tested.
async function tailorQueue({ jobs = [], persona, roundId, onProgress = null, deps = {} } = {}) {
  const backendApi = deps.backend || backend;
  const renderApi = deps.render || render;
  const baseTextApi = deps.baseText || baseText;
  const report = {
    requested: jobs.length,
    accepted: 0,
    rejected: 0,
    fallback: 0,
    skipped: 0,
    backend: null,
    baseTextSource: null,
    roundId,
    reasons: {},
  };
  const note = (reason) => { report.reasons[reason] = (report.reasons[reason] || 0) + 1; };

  if (!roundId) { report.skipped = jobs.length; note('no round id'); return report; }
  if (!jobs.length) return report;

  // 1. Is there a model at all? Asked once for the batch, not once per job.
  const chosen = await backendApi.detect();
  report.backend = chosen.kind;
  if (!chosen.available) {
    report.fallback = jobs.length;
    note(`no model backend: ${chosen.detail}`);
    friction(`tailoring skipped — ${chosen.detail}`, 'tailor:no-backend');
    // Rows are still written: "we tried and could not" is worth knowing later.
    for (const job of jobs) recordFallback(job, { persona, roundId, verdict: chosen.detail });
    return report;
  }

  // 2. The base resume text, once per persona.
  const base = baseTextApi.extract(persona);
  report.baseTextSource = base.source;
  if (!base.ok) {
    report.fallback = jobs.length;
    note('no base resume text');
    friction(`tailoring skipped — ${base.detail}`, 'tailor:no-base-text');
    for (const job of jobs) recordFallback(job, { persona, roundId, verdict: base.detail });
    return report;
  }
  const baseHash = manifest.shortHash(base.text);

  // 3. One browser for every render in the batch.
  const geo = renderApi.pageGeometry(persona.resumePath);
  let renderer = null;
  try {
    renderer = await renderApi.openRenderer();
  } catch (e) {
    // No renderer means no uploadable PDF, so there is nothing to gain from calling a
    // model. Sources would be written and immediately unusable.
    report.fallback = jobs.length;
    note('renderer unavailable');
    friction(`tailoring skipped — could not launch Chrome to render: ${e.message}`, 'tailor:no-renderer');
    for (const job of jobs) recordFallback(job, { persona, roundId, verdict: `renderer unavailable: ${e.message}` });
    return report;
  }

  try {
    let n = 0;
    for (const job of jobs) {
      n += 1;
      const jobId = manifest.jobIdFor(job.url || '');
      const jd = job.description || job.jd || job.jobDescription || '';
      const meta = {
        jobId, url: job.url || '', company: job.company || '', role: job.role || '',
        persona: persona.persona || '', roundId, baseHash, backend: chosen.kind,
      };
      if (onProgress) onProgress({ n, of: jobs.length, company: job.company, role: job.role });

      // Already tailored in this round (a resumed run, or a second batch over the same
      // queue): keep it rather than paying for the same document twice.
      const existing = manifest.acceptedRender({ jobId, roundId });
      if (existing) { report.accepted += 1; report.skipped += 1; note('already tailored'); continue; }

      if (!jd || jd.trim().length < 120) {
        // Tailoring to a posting nobody captured would be tailoring to nothing.
        report.fallback += 1;
        note('no job description');
        manifest.record({ ...meta, status: 'fallback', verdict: 'no job description captured' });
        continue;
      }

      let tailored;
      try {
        const res = await backendApi.tailorOne({ base: base.text, jobDescription: jd, persona: persona.persona });
        tailored = res.text;
      } catch (e) {
        report.fallback += 1;
        note('model call failed');
        friction(`tailoring failed for ${job.company || job.url}: ${e.message}`, 'tailor:' + e.message.slice(0, 80));
        manifest.record({ ...meta, status: 'fallback', verdict: `model call failed: ${e.message}`.slice(0, 300) });
        continue;
      }

      const verdict = assess(tailored, { base: base.text, fullName: persona.fullName });
      const tailoredHash = manifest.shortHash(tailored);
      if (!verdict.ok) {
        report.rejected += 1;
        note('rejected: ' + verdict.verdict);
        // The rejected source is still written: diagnosing a bad tailoring pass without
        // the document it produced is guesswork.
        const src = paths.resumeSource(roundId, jobId);
        try { fs.writeFileSync(src, tailored, { mode: 0o600 }); } catch { /* best effort */ }
        manifest.record({ ...meta, status: 'rejected', verdict: verdict.verdict, tailoredHash, sourcePath: src });
        continue;
      }

      // SOURCE FIRST, then render. The source is the permanent artifact; if the render
      // fails we still hold what the model produced and can regenerate later.
      const sourcePath = paths.resumeSource(roundId, jobId);
      try {
        fs.writeFileSync(sourcePath, tailored, { mode: 0o600 });
      } catch (e) {
        report.fallback += 1;
        note('source write failed');
        manifest.record({ ...meta, status: 'fallback', verdict: `could not write source: ${e.message}`.slice(0, 200), tailoredHash });
        continue;
      }

      const renderPath = paths.resumeRender(roundId, jobId);
      try {
        const r = await renderer.render(tailored, renderPath, geo);
        // The same file check the uploader will apply. Catching a bad render here means
        // the resolver never hands a broken PDF to a form.
        const v = verifyResumeFile(renderPath);
        if (!v.ok) throw new Error(`rendered file failed verification: ${v.detail}`);
        report.accepted += 1;
        manifest.record({
          ...meta, status: 'accepted', verdict: verdict.verdict, tailoredHash,
          sourcePath, renderPath, renderBytes: r.bytes,
        });
      } catch (e) {
        report.fallback += 1;
        note('render failed');
        friction(`render failed for ${job.company || job.url}: ${e.message}`, 'tailor:render');
        manifest.record({
          ...meta, status: 'fallback', verdict: `render failed: ${e.message}`.slice(0, 300),
          tailoredHash, sourcePath,
        });
      }
    }
  } finally {
    await renderer.close();
  }

  return report;
}

function recordFallback(job, { persona, roundId, verdict }) {
  manifest.record({
    jobId: manifest.jobIdFor(job.url || ''),
    url: job.url || '', company: job.company || '', role: job.role || '',
    persona: (persona && persona.persona) || '', roundId,
    status: 'fallback', verdict: String(verdict || '').slice(0, 300),
  });
}

// ── retention ──────────────────────────────────────────────────────────────

// Delete rendered PDFs past the retention window. Sources are never touched — that is
// the entire retention design: the .md is a few KB and answers "what did they see?"
// three months later, the .pdf is hundreds of KB and regenerates from it on demand.
function gc({ retentionDays = null, dryRun = false } = {}) {
  const days = retentionDays === null
    ? Number(require('../core/config')().resumeRenderRetentionDays)
    : Number(retentionDays);
  const cutoff = Date.now() - days * 86400000;

  const deleted = [];
  let keptSources = 0;
  let bytes = 0;

  for (const row of manifest.all()) {
    if (!row.renderPath || row.renderedDeletedAt) continue;
    if (!fs.existsSync(row.renderPath)) continue;
    let mtime;
    try { mtime = fs.statSync(row.renderPath).mtimeMs; } catch { continue; }
    if (mtime >= cutoff) continue;
    const size = (() => { try { return fs.statSync(row.renderPath).size; } catch { return 0; } })();
    if (!dryRun) {
      try { fs.rmSync(row.renderPath, { force: true }); } catch { continue; }
      manifest.markRenderDeleted(row);
    }
    deleted.push({ jobId: row.jobId, roundId: row.roundId, path: row.renderPath, bytes: size, company: row.company });
    bytes += size;
  }
  // DISTINCT sources. The manifest is append-only and markRenderDeleted adds a row
  // per deletion that still carries its sourcePath, so counting rows would report every
  // GC'd source twice.
  const sources = new Set();
  for (const row of manifest.all()) {
    if (row.sourcePath && fs.existsSync(row.sourcePath)) sources.add(row.sourcePath);
  }
  keptSources = sources.size;

  return {
    retentionDays: days,
    dryRun,
    deletedRenders: deleted.length,
    reclaimedBytes: bytes,
    reclaimedMb: Math.round((bytes / 1048576) * 10) / 10,
    keptSources,
    deleted: deleted.slice(0, 50),
    note: 'Sources are permanent — regenerate any deleted PDF with `apply-agent resume render <job-id>`.',
  };
}

// Regenerate a rendered PDF from its stored source.
async function renderFromSource(jobId, { personas = null } = {}) {
  const { findSource } = require('./resolve');
  const row = findSource(jobId);
  if (!row) throw new Error(`no stored source for ${jobId} — nothing to render from`);

  const md = fs.readFileSync(row.sourcePath, 'utf8');
  const all = personas || require('../personas').personas;
  const persona = all[row.persona] || null;
  const outPath = row.renderPath || paths.resumeRender(row.roundId, row.jobId);

  const r = await render.renderOne(md, outPath, { basePdfPath: persona ? persona.resumePath : '' });
  manifest.record({
    ...row,
    status: 'accepted',
    verdict: 'rendered from stored source',
    renderPath: outPath,
    renderBytes: r.bytes,
    renderedDeletedAt: null,
  });
  return { jobId, path: outPath, bytes: r.bytes, sourcePath: row.sourcePath, geometry: r.geometry };
}

module.exports = { tailorQueue, gc, renderFromSource, assess };
