// The single resolver: which resume file does THIS job upload?
//
// One function, one place. The alternative — teaching each of six ATS handlers to
// choose between a base and a tailored file — is how the upload code drifted into six
// incompatible copies in the first place. Handlers keep reading `a.resumePath`; the
// runner points that at the resolved file before dispatching the job.
//
// The rule: the accepted tailored render for this job in this round, if one exists on
// disk. Base resume otherwise. "Otherwise" covers every failure the tailoring pass can
// have — tailoring off, no model backend, no base text, model refused, render failed,
// PDF already GC'd — which is why the fallback is unconditional rather than a special
// case per reason.
const fs = require('fs');

const manifest = require('./manifest');
const { verifyResumeFile } = require('./verify');

// resolveResume({ persona, url, roundId, jobId }) ->
//   { path, variant, jobId, tailoredHash|null, reason }
//
// `variant` is what the ledger records: the tailored hash, or the string 'base'. That
// is the difference between "we know what they saw" and "we think it was probably the
// tailored one".
// Which of a persona's BASE resumes fits this job title?
//
// `resumeVariants` is optional: e.g. three near-identical support resumes where
// the right one depends on whether the posting is a help desk or a call centre.
// Personas without the field are unaffected and keep returning
// `persona.resumePath`, so this is purely additive.
//
// Title only, never the JD body - see the comment on resumeVariants in
// src/personas.js for why matching the description picks the wrong one.
function baseResumeFor(persona, title) {
  const fallback = persona && persona.resumePath ? persona.resumePath : '';
  const variants = (persona && persona.resumeVariants) || [];
  const t = String(title || '');
  if (!t) return { path: fallback, baseVariant: 'base' };
  for (const v of variants) {
    if (v.match && v.match.test(t) && v.pdf && fs.existsSync(v.pdf)) {
      return { path: v.pdf, docx: v.docx || '', baseVariant: v.key };
    }
  }
  return { path: fallback, baseVariant: 'base' };
}

function resolveResume({ persona, url = '', roundId = '', jobId = '', title = '' } = {}) {
  const picked = baseResumeFor(persona, title);
  const basePath = picked.path;
  const id = jobId || manifest.jobIdFor(url);
  const base = {
    path: basePath,
    // `variant` stays exactly 'base' so every existing `variant !== 'base'`
    // check still means "a tailored render was used". Which of the base
    // resumes was picked rides alongside it instead of overloading this.
    variant: 'base',
    baseVariant: picked.baseVariant,
    baseDocx: picked.docx || (persona && persona.resumeDocx) || '',
    jobId: id,
    tailoredHash: null,
  };

  if (!roundId) return { ...base, reason: 'no round in context' };

  const row = manifest.acceptedRender({ jobId: id, roundId });
  if (!row) return { ...base, reason: 'no accepted tailored resume for this job' };

  // The upload verification added earlier applies to tailored files exactly as it does
  // to base ones — a tailored PDF that is empty or not a PDF must never be uploaded,
  // and finding out here is cheaper than finding out at the file input.
  const v = verifyResumeFile(row.renderPath);
  if (!v.ok) {
    return { ...base, reason: `tailored render unusable (${v.reason}) — using base` };
  }

  return {
    path: row.renderPath,
    variant: row.tailoredHash || 'tailored',
    jobId: id,
    tailoredHash: row.tailoredHash || null,
    reason: 'accepted tailored resume',
    sourcePath: row.sourcePath,
  };
}

// Does a stored SOURCE exist for this job, whatever happened to the render? Used by
// `resume render <job-id>` — the source is permanent, so a GC'd PDF is regenerable
// months later.
function findSource(jobId) {
  const rows = manifest.all().filter((r) => r.jobId === jobId && r.sourcePath);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (fs.existsSync(rows[i].sourcePath)) return rows[i];
  }
  return null;
}

module.exports = { resolveResume, findSource };
