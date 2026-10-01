// Retention for run artifacts, on the same window as rendered resume PDFs.
//
// WHAT ACCUMULATES, AND WHY IT IS NOT FREE
//   .state/runs/logs/     one batch log per fresh-browser batch. Each opens with the
//                         persona and email and then lists every job URL evaluated.
//   .state/runs/dryrun/   full-page screenshots of filled forms — name, phone, address,
//                         work-authorization answers, all rendered.
//
// Both are PII-bearing, which is why src/core/paths.js already puts them in the 0700
// state dir rather than the repo root. Neither is worth keeping indefinitely: a batch
// log matters while you are diagnosing that batch, and a dry-run screenshot matters
// until you have looked at it.
//
// SAME WINDOW AS RENDERED PDFS, deliberately. One retention number is one thing to
// reason about, and these artifacts have the same shape of value: useful now, worthless
// and bulky later, with the durable record living elsewhere (the ledger for what was
// applied to, the tailored .md sources for what was sent).
//
// The asymmetry worth restating: tailored resume SOURCES are permanent because they
// answer "what did this employer see?" months later. Logs and screenshots answer "what
// happened last night", which stops being a question.
const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const config = require('./config');

const mb = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

// Delete files under a directory older than the cutoff. Non-recursive by design: both
// target directories are flat, and a recursive delete under a configurable path is a
// worse tool than this needs to be.
function sweepDir(dir, cutoffMs, { dryRun = false, label = '' } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
  } catch {
    return { label, dir, present: false, deleted: 0, bytes: 0, kept: 0 };
  }
  let deleted = 0;
  let bytes = 0;
  let kept = 0;
  const examples = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.mtimeMs >= cutoffMs) { kept += 1; continue; }
    if (!dryRun) {
      try { fs.rmSync(full, { force: true }); } catch { continue; }
    }
    deleted += 1;
    bytes += st.size;
    if (examples.length < 5) examples.push(e.name);
  }
  return { label, dir, present: true, deleted, bytes, mb: mb(bytes), kept, examples };
}

// gcRuns({ retentionDays, dryRun }) -> report
function gcRuns({ retentionDays = null, dryRun = false } = {}) {
  const days = retentionDays === null ? Number(config().resumeRenderRetentionDays) : Number(retentionDays);
  const cutoff = Date.now() - days * 86400000;

  const parts = [
    sweepDir(paths.runLogs(), cutoff, { dryRun, label: 'batch logs' }),
    sweepDir(paths.dryRuns(), cutoff, { dryRun, label: 'dry-run screenshots' }),
  ];
  const bytes = parts.reduce((n, p) => n + p.bytes, 0);
  return {
    retentionDays: days,
    dryRun,
    deletedFiles: parts.reduce((n, p) => n + p.deleted, 0),
    keptFiles: parts.reduce((n, p) => n + p.kept, 0),
    reclaimedBytes: bytes,
    reclaimedMb: mb(bytes),
    parts,
  };
}

// Everything on the retention window: rendered resume PDFs plus run artifacts. This is
// what `apply-agent gc` runs, so one command covers everything that grows without
// bound. Resume SOURCES are never touched.
function gcAll({ retentionDays = null, dryRun = false } = {}) {
  const { gc: gcRenders } = require('../resume/tailor');
  const renders = gcRenders({ retentionDays, dryRun });
  const runs = gcRuns({ retentionDays, dryRun });
  const bytes = (renders.reclaimedBytes || 0) + (runs.reclaimedBytes || 0);
  return {
    retentionDays: runs.retentionDays,
    dryRun,
    reclaimedMb: mb(bytes),
    renders,
    runs,
    note: 'Tailored resume SOURCES are permanent and were not touched — they regenerate '
      + 'any deleted PDF via `apply-agent resume render <job-id>`.',
  };
}

// Current size of the run-artifact directories, for run output and doctor.
function runArtifactUsage() {
  const measure = (dir) => {
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile());
      let bytes = 0;
      for (const f of files) {
        try { bytes += fs.statSync(path.join(dir, f.name)).size; } catch { /* vanished */ }
      }
      return { files: files.length, bytes };
    } catch { return { files: 0, bytes: 0 }; }
  };
  const logs = measure(paths.runLogs());
  const shots = measure(paths.dryRuns());
  return {
    logs: { ...logs, mb: mb(logs.bytes) },
    dryRuns: { ...shots, mb: mb(shots.bytes) },
    totalMb: mb(logs.bytes + shots.bytes),
  };
}

module.exports = { gcRuns, gcAll, runArtifactUsage, sweepDir };
