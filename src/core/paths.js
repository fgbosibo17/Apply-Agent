// Owner-only local state directory.
//
// Ported from job-application-agent's "private state dir" model: candidate
// ledgers, queues, rounds and autonomy grants live OUTSIDE the tracked repo
// files so they can never be committed by accident. The legacy CSVs
// (applications-log.csv / seen-jobs.csv) stay where they are for backwards
// compatibility — the NDJSON ledger is the new source of truth.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// STATE_DIR override lets tests (and a multi-machine setup) point elsewhere.
function stateDir() {
  return process.env.APPLY_AGENT_STATE_DIR
    ? path.resolve(process.env.APPLY_AGENT_STATE_DIR)
    : path.join(ROOT, '.state');
}

// mode 0700: owner-only. Re-applied on every ensure so a loosened dir is fixed.
function ensureStateDir() {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX */ }
  return dir;
}

function statePath(...parts) {
  return path.join(ensureStateDir(), ...parts);
}

// A subdirectory of the state dir, created 0700 on demand. Used for run
// artifacts (batch logs, dry-run screenshots) which are written in bulk during a
// run rather than being single state files.
function stateSubdir(...parts) {
  const dir = path.join(ensureStateDir(), ...parts);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort on non-POSIX */ }
  return dir;
}

const paths = {
  root: ROOT,
  stateDir,
  ensureStateDir,
  statePath,
  stateSubdir,
  // Run artifacts. These used to land in the repo ROOT (cloud-nbatch-1.log,
  // dryrun-<company>.png) where they piled up untracked. Both kinds carry
  // candidate PII — a batch log header names the persona and email, and a
  // dry-run screenshot is a full-page capture of a form filled with name, phone,
  // address and work-authorization answers — so they belong in the owner-only
  // 0700 state dir, not next to the source.
  runLogs: () => stateSubdir('runs', 'logs'),
  dryRuns: () => stateSubdir('runs', 'dryrun'),
  // Machine identity + the two run guards. Locks live under the state dir so they
  // travel with the shared state: the profile lock has to be visible to BOTH
  // machines to mean anything, which is the whole point of it.
  machine: () => statePath('machine.json'),
  // State schema version stamp. Guards against older code reading state written by a
  // newer commit on the other machine and silently dropping fields it does not know.
  schema: () => statePath('schema.json'),
  locksDir: () => stateSubdir('locks'),
  lock: (name) => path.join(stateSubdir('locks'), name),
  // Cooperative stop signal. A separate file per round rather than a field in
  // rounds.json: the stopping process and the running one would otherwise
  // read-modify-write the same JSON concurrently, and the whole point is to signal a
  // live run without touching what it is writing.
  stopFlag: (roundId) => path.join(stateSubdir('stop'), `${roundId}.stop`),
  stopDir: () => stateSubdir('stop'),
  // ── Tailored resumes ──────────────────────────────────────────────────────
  //
  // RETENTION IS DELIBERATELY SPLIT, and the split is the whole design:
  //
  //   tailored/<round>/<job-id>.md   the SOURCE. A few KB. KEPT FOREVER.
  //   tailored/<round>/<job-id>.pdf  the RENDER. Hundreds of KB. GC'd after 30 days.
  //
  // Hundreds of applications each carrying a PDF becomes gigabytes on a machine that
  // shares its disk with other services. But when a recruiter calls three months
  // later, the one question that matters is "what did they actually see?" — and an
  // agent that cannot answer that is worse than useless, it is embarrassing.
  //
  // The markdown source answers it, costs almost nothing, and regenerates the PDF on
  // demand (`apply-agent resume render <job-id>`). So the source is permanent and the
  // rendered PDF is disposable. Deleting a PDF loses nothing recoverable; deleting a
  // source loses the record of what an employer received.
  resumesDir: () => stateSubdir('resumes'),
  // Extracted base resume text per persona, cached so the extraction ladder
  // (docx / pdftotext / textutil) runs once rather than per job.
  resumeBaseDir: () => stateSubdir('resumes', 'base'),
  resumeBaseText: (persona) => path.join(stateSubdir('resumes', 'base'), `${persona}.txt`),
  resumeTailoredDir: () => stateSubdir('resumes', 'tailored'),
  resumeRoundDir: (roundId) => stateSubdir('resumes', 'tailored', String(roundId)),
  resumeSource: (roundId, jobId) => path.join(stateSubdir('resumes', 'tailored', String(roundId)), `${jobId}.md`),
  resumeRender: (roundId, jobId) => path.join(stateSubdir('resumes', 'tailored', String(roundId)), `${jobId}.pdf`),
  resumeManifest: () => statePath('resumes', 'manifest.ndjson'),
  applications: () => statePath('applications.ndjson'),
  outcomes: () => statePath('outcomes.ndjson'),
  attention: () => statePath('attention.ndjson'),
  friction: () => statePath('friction.ndjson'),
  rounds: () => statePath('rounds.json'),
  autonomy: () => statePath('autonomy.json'),
  profile: () => statePath('profile.json'),
  reviewAck: () => statePath('review-ack.json'),
  legacyApplicationsCsv: path.join(ROOT, 'applications-log.csv'),
  legacySeenCsv: path.join(ROOT, 'seen-jobs.csv'),
  sourcesCatalog: path.join(ROOT, 'data', 'sources.json'),
};

module.exports = paths;
