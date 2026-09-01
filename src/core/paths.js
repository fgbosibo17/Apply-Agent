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
