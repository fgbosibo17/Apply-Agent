// S3 state sync: pull before a run, push after.
//
// The two machines share one logical ledger. git carries the tracked run output; this
// carries the untracked state dir — the NDJSON ledger, rounds, queues, the resume
// manifest and tailored sources.
//
// ── WHAT MUST NEVER TRAVEL, AND WHY ────────────────────────────────────────
// Three exclusions, each guarding a specific failure:
//
//   machine.json   Machine IDENTITY. If both hosts shared a machine id, the profile
//                  lock's "is this mine?" test would answer yes for the other machine's
//                  lock — and then reclaim it the moment that host's pid looked dead
//                  locally. Two runs on one profile, ledger forked. This is the most
//                  dangerous file in the directory to sync.
//   locks/         A lock describes a process on one host. Copied elsewhere it is a
//                  claim about a pid that means nothing there.
//   stop/          A stop request addresses one running process, not a round in the
//                  abstract.
//
// browser-profile-* cannot appear in a payload because they live in the repo root, not
// the state dir — but the assertion below is explicit anyway, because the cost of being
// wrong is a Chrome profile with one machine's OS and device fingerprint replayed on
// another, which is exactly the mismatch CAPTCHA scoring looks for.
//
// ── DIVERGENCE ─────────────────────────────────────────────────────────────
// After pulling, the schema gate runs. If the state that just arrived was written by a
// newer commit than this checkout, the run aborts: continuing would rewrite those rows
// without the fields this code does not know about.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('./paths');
const schema = require('./schema');

// Never synced, in either direction.
const EXCLUDES = ['machine.json', 'locks/*', 'stop/*'];
const FORBIDDEN = /(^|[\\/])browser-profile-/;

const target = () => (process.env.APPLY_AGENT_STATE_S3 || '').trim().replace(/\/+$/, '');
const profileArgs = () => {
  const p = (process.env.APPLY_AGENT_STATE_S3_PROFILE || process.env.AWS_PROFILE || '').trim();
  return p ? ['--profile', p] : [];
};

// Belt and braces: refuse a payload that names a browser profile, whatever built it.
function assertNoProfiles(paths_) {
  for (const p of paths_) {
    if (FORBIDDEN.test(p)) {
      throw new Error(`refusing to sync a browser profile (${p}). Profiles carry OS and device fingerprint and are never copied between machines.`);
    }
  }
  return true;
}

function run(args, { timeoutMs = 300000 } = {}) {
  try {
    const stdout = execFileSync('aws', args, {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: (stdout || '').trim() };
  } catch (e) {
    return {
      ok: false,
      stdout: ((e.stdout || '') + '').trim(),
      error: ((e.stderr || '') + '').trim() || e.message,
      code: e.status === undefined ? null : e.status,
    };
  }
}

const syncArgs = (from, to) => {
  const args = ['s3', 'sync', from, to, '--only-show-errors'];
  for (const ex of EXCLUDES) args.push('--exclude', ex);
  assertNoProfiles([from, to]);
  return args.concat(profileArgs());
};

// Pull remote state down, then check the schema. Throws SchemaTooOldError on divergence.
function pull({ dryRun = false } = {}) {
  const base = target();
  if (!base) {
    // Not configured is not a failure: a single-machine setup needs no sync.
    return { skipped: true, configured: false, reason: 'APPLY_AGENT_STATE_S3 is unset', schema: schema.status() };
  }
  const local = paths.ensureStateDir();
  const args = syncArgs(`${base}/state/`, local);
  if (dryRun) args.push('--dryrun');

  const res = run(args);
  if (!res.ok) {
    return { skipped: false, configured: true, ok: false, error: res.error, from: `${base}/state/`, schema: schema.status() };
  }
  // Divergence check AFTER the pull: the state we now hold may be newer than this code.
  const gate = schema.assertCompatible();
  return { skipped: false, configured: true, ok: true, from: `${base}/state/`, to: local, dryRun, schema: gate, excluded: EXCLUDES };
}

// Push local state up.
function push({ dryRun = false } = {}) {
  const base = target();
  if (!base) {
    return { skipped: true, configured: false, reason: 'APPLY_AGENT_STATE_S3 is unset' };
  }
  const local = paths.ensureStateDir();
  const args = syncArgs(local, `${base}/state/`);
  if (dryRun) args.push('--dryrun');

  const res = run(args);
  return res.ok
    ? { skipped: false, configured: true, ok: true, from: local, to: `${base}/state/`, dryRun, excluded: EXCLUDES }
    : { skipped: false, configured: true, ok: false, error: res.error, to: `${base}/state/` };
}

// What is here and what is configured, without touching the network.
function status() {
  const base = target();
  let localFiles = 0;
  let localBytes = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      try { const st = fs.statSync(full); localFiles += 1; localBytes += st.size; } catch { /* vanished */ }
    }
  };
  walk(paths.stateDir());
  return {
    configured: !!base,
    target: base ? `${base}/state/` : null,
    stateDir: paths.stateDir(),
    localFiles,
    localMb: Math.round((localBytes / 1048576) * 10) / 10,
    excluded: EXCLUDES,
    schema: schema.status(),
    note: base ? null : 'Set APPLY_AGENT_STATE_S3 to sync state between machines.',
  };
}

module.exports = { pull, push, status, assertNoProfiles, EXCLUDES, FORBIDDEN };
