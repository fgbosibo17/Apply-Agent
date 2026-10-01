// The tailored-resume manifest: .state/resumes/manifest.ndjson
//
// One append-only row per tailoring attempt, which is the record that answers "what
// did this employer actually see?" long after the rendered PDF has been GC'd. Without
// it the stored .md files are a directory of hashes nobody can map back to a job.
//
// Append-only for the same reason the ledger is: a row describes what happened at a
// moment, and rewriting history would defeat the point of keeping it.
const crypto = require('crypto');
const fs = require('fs');

const paths = require('../core/paths');
const { append, readAll } = require('../core/ndjson');
const machine = require('../core/machine');

const SCHEMA = 1;

// Statuses, and what each one means for the upload:
//   accepted  a tailored PDF exists and will be uploaded
//   rejected  the model produced something unusable (empty, wrong shape, too short) —
//             base PDF is uploaded
//   fallback  tailoring could not run at all (no backend, no base text, render
//             failed) — base PDF is uploaded
const STATUSES = ['accepted', 'rejected', 'fallback'];

const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const shortHash = (s) => sha256(s).slice(0, 16);

// A stable id for a job, so the same posting maps to the same file on both machines
// and across rounds. Derived from the canonical URL rather than a counter, because a
// counter would collide the moment two machines tailor concurrently.
function jobIdFor(url) {
  const { canonicalizeUrl } = require('../core/canonical');
  const canonical = canonicalizeUrl(url || '');
  return 'job_' + sha256(canonical || url || 'unknown').slice(0, 12);
}

function record(entry) {
  const row = {
    schema: SCHEMA,
    ts: entry.ts || new Date().toISOString(),
    jobId: entry.jobId || '',
    url: entry.url || '',
    company: entry.company || '',
    role: entry.role || '',
    persona: entry.persona || '',
    roundId: entry.roundId || '',
    machineId: entry.machineId || machine.id(),
    baseHash: entry.baseHash || '',
    tailoredHash: entry.tailoredHash || '',
    // Kept as a field even without a model review step: mechanical checks (empty
    // output, implausible length, lost candidate name, render failure) produce a
    // verdict, and the reason is what makes a rejected row diagnosable.
    verdict: entry.verdict || '',
    status: STATUSES.includes(entry.status) ? entry.status : 'fallback',
    backend: entry.backend || '',
    sourcePath: entry.sourcePath || '',
    renderPath: entry.renderPath || '',
    renderBytes: Number(entry.renderBytes) || 0,
    // Set by `resume gc` when the rendered PDF is deleted, so a missing file is
    // distinguishable from one that never rendered.
    renderedDeletedAt: entry.renderedDeletedAt || null,
  };
  return append(paths.resumeManifest(), row);
}

const all = () => readAll(paths.resumeManifest());

// The latest row for a job — append-only, so the last write wins.
function latestFor({ jobId, roundId } = {}) {
  const rows = all().filter((r) => r.jobId === jobId && (!roundId || r.roundId === roundId));
  return rows.length ? rows[rows.length - 1] : null;
}

// The accepted tailored render for a job in a round, if the file is still on disk.
// Both conditions matter: an accepted row whose PDF has been GC'd must fall back to
// base rather than hand a nonexistent path to the uploader.
function acceptedRender({ jobId, roundId } = {}) {
  const row = latestFor({ jobId, roundId });
  if (!row || row.status !== 'accepted') return null;
  if (!row.renderPath || !fs.existsSync(row.renderPath)) return null;
  return row;
}

// Mark a rendered PDF as deleted (gc), keeping the row's history.
function markRenderDeleted(row) {
  return record({ ...row, renderedDeletedAt: new Date().toISOString(), renderBytes: 0 });
}

function summary() {
  const rows = all();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  return {
    rows: rows.length,
    byStatus,
    rounds: [...new Set(rows.map((r) => r.roundId).filter(Boolean))],
  };
}

module.exports = {
  record, all, latestFor, acceptedRender, markRenderDeleted, summary,
  jobIdFor, sha256, shortHash, STATUSES, SCHEMA,
};
