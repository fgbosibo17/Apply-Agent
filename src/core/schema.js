// State schema versioning.
//
// THE FAILURE THIS PREVENTS
// Two machines will drift onto different commits — the laptop gets a change on
// Tuesday, the server pulls it on Friday, and in between they share one logical
// ledger over git and S3. If the newer code writes a field the older code does not
// know about, the older code reads the row, keeps the fields it recognises, and writes
// it back without the rest. No error, no warning: the field is simply gone from the
// one file whose whole purpose is being an accurate record of what was submitted.
//
// That is invisible data loss, and it is unrecoverable — you cannot restore a field
// nobody noticed was dropped. So the state carries a version stamp and old code
// refuses to touch newer state.
//
// THE ASYMMETRY IS DELIBERATE
//   state newer than code  -> REFUSE. The code cannot know what it would be dropping.
//                             The fix is `git pull`, which is cheap and obvious.
//   state older than code  -> MIGRATE FORWARD. Newer code knows what the older shape
//                             looked like, so it can fill in what is missing. This is
//                             the normal upgrade path and must not need a flag.
//   equal                  -> proceed.
//
// WHEN TO BUMP
// Bump CODE_VERSION whenever a LEDGER or QUEUE record shape changes — a new field, a
// renamed field, a changed meaning. Not for a new file, not for a new CLI verb, not
// for a config default: those do not make one machine's writes lossy in the other's
// hands.
const fs = require('fs');

const paths = require('./paths');
const machine = require('./machine');

// ── the version ────────────────────────────────────────────────────────────
//
// 1  the original ledger/queue shapes
// 2  ledger rows gained `machineId` (which host wrote this row) and `resumeVariant`
//    (the tailored resume's hash, or 'base'); round records gained `profileKey`,
//    `machineId` and `hostname`. Older code reading a v2 ledger would drop all five,
//    which is exactly the loss this file exists to stop.
// 3  attention items gained `machineId` (which host must resolve them — a login lives
//    in one machine's browser profile and profiles never travel); round records gained
//    `progress` (mid-run counts, so a long run is observable) and `stopped`.
const CODE_VERSION = 3;

// What each version added, so a refusal can say what the gap actually is rather than
// just quoting two numbers at someone.
const CHANGELOG = {
  1: 'original ledger and queue record shapes',
  2: 'ledger: +machineId, +resumeVariant; rounds: +profileKey, +machineId, +hostname',
  3: 'attention: +machineId; rounds: +progress, +stopped',
};

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.schema(), 'utf8'));
    if (parsed && Number.isInteger(parsed.version)) return parsed;
    return null;
  } catch { return null; }
}

function write(version, extra = {}) {
  const record = {
    version,
    updatedAt: new Date().toISOString(),
    updatedBy: machine.id(),
    codeVersion: CODE_VERSION,
    ...extra,
  };
  fs.writeFileSync(paths.schema(), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

// Where do we stand? Never throws; callers decide what the answer means.
//
//   { codeVersion, stateVersion, match, relation, stamped, detail }
//   relation: 'match' | 'state-newer' | 'state-older' | 'unstamped'
function status() {
  const rec = read();
  if (!rec) {
    return {
      codeVersion: CODE_VERSION,
      stateVersion: null,
      match: true,           // nothing to disagree with
      relation: 'unstamped',
      stamped: false,
      detail: `state is unstamped; this code writes v${CODE_VERSION}`,
    };
  }
  const relation = rec.version === CODE_VERSION
    ? 'match'
    : (rec.version > CODE_VERSION ? 'state-newer' : 'state-older');
  return {
    codeVersion: CODE_VERSION,
    stateVersion: rec.version,
    match: relation === 'match',
    relation,
    stamped: true,
    updatedAt: rec.updatedAt || null,
    updatedBy: rec.updatedBy || null,
    detail: relation === 'match'
      ? `state v${rec.version} matches this code`
      : relation === 'state-newer'
        ? `state is v${rec.version}, this code writes v${CODE_VERSION} — the repo is behind`
        : `state is v${rec.version}, this code writes v${CODE_VERSION} — will migrate forward`,
  };
}

// Refused because the local repo is older than the state it is about to read.
class SchemaTooOldError extends Error {
  constructor(st) {
    super(
      `refusing to run: state is schema v${st.stateVersion} but this code only understands v${st.codeVersion}. `
      + `Another machine has written state from a newer commit. Update this repo (git pull && npm ci) and retry. `
      + `Running anyway would silently drop the fields this code does not know about — `
      + `v${st.codeVersion + 1}+ added: ${Object.entries(CHANGELOG).filter(([v]) => Number(v) > st.codeVersion).map(([v, d]) => `v${v} ${d}`).join('; ') || 'unknown changes'}.`
    );
    this.name = 'SchemaTooOldError';
    this.schema = st;
    // Rendered by src/cli.js alongside the error message.
    this.failures = [{
      name: 'schema',
      detail: `state v${st.stateVersion} > code v${st.codeVersion}`,
      remedy: 'git pull && npm ci, then retry. Do not force it: older code writing newer state drops fields silently.',
    }];
  }
}

// The gate. Call before READING state in a way that could write it back.
//
//   assertCompatible()            -> status, or throws SchemaTooOldError
//   assertCompatible({ migrate })  migrate: false to stamp without backfilling
//
// Stamps unstamped state, and migrates older state forward through the existing
// migrate path rather than inventing a second one.
function assertCompatible({ migrate = true, quiet = false } = {}) {
  const st = status();

  if (st.relation === 'state-newer') throw new SchemaTooOldError(st);

  if (st.relation === 'unstamped') {
    // Fresh or pre-versioning state. Stamp it at the current version; there is no
    // older shape to convert because nothing recorded which shape it was.
    write(CODE_VERSION, { stampedReason: 'state was unstamped' });
    return { ...status(), action: 'stamped' };
  }

  if (st.relation === 'state-older') {
    let migrated = null;
    if (migrate) {
      // Forward migration reuses src/core/migrate.js — the same backfill the CLI's
      // `migrate` verb runs. It is idempotent (it skips rows already in the ledger),
      // so running it on an upgrade is safe even when there is nothing to do.
      try {
        const m = require('./migrate');
        migrated = {
          applications: m.migrateApplications({}),
          seen: m.migrateSeen({}),
        };
      } catch (e) {
        migrated = { error: e.message };
      }
    }
    write(CODE_VERSION, { migratedFrom: st.stateVersion });
    if (!quiet) {
      // stderr, not stdout: src/cli.js promises strict JSON on stdout, and a migration
      // notice printed there would make `round start` unparseable for its callers.
      console.error(`[schema] migrated state v${st.stateVersion} -> v${CODE_VERSION}`
        + (migrated && migrated.applications ? ` (backfilled ${migrated.applications.migrated} ledger row(s))` : ''));
    }
    return { ...status(), action: 'migrated', from: st.stateVersion, migrated };
  }

  return { ...st, action: 'none' };
}

module.exports = { CODE_VERSION, CHANGELOG, status, assertCompatible, read, write, SchemaTooOldError };
