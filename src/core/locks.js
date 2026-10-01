// Two guards, for two different problems. Conflating them is the mistake to avoid:
// they have different scopes, different lifetimes, and a caller that hits one needs
// to do something different from a caller that hits the other.
//
// ── PROFILE LOCK — cross-machine correctness ────────────────────────────────
// `.state/locks/<profileKey>.lock`, visible to BOTH machines because the state dir
// is what they share. It guards a browser PROFILE DIRECTORY, not a persona:
//
//   * cloud and fullstack are one identity on one profile (see src/personas.js), so
//     they must never run concurrently anywhere — same Chrome profile, exclusive
//     lock, and two live sessions for one account invalidate each other.
//   * qa is a different account with its own profile, so it stays free to run
//     alongside either of them.
//
// Locking the persona instead would have permitted cloud-on-laptop and
// fullstack-on-server simultaneously, which is precisely the collision that forks
// the ledger and defeats dedup.
//
// ── HOST SEMAPHORE — local resources ───────────────────────────────────────
// `.state/locks/host-<machineId>.sem`, namespaced by machine so one host's runs
// never block the other's. It limits this host to ONE browser run regardless of
// persona: two Playwright Chrome sessions on a 14 GB 2015 laptop degrade each other,
// which is the exact failure run-loop.js's fresh-browser batching exists to avoid.
//
// ── LIVENESS ───────────────────────────────────────────────────────────────
// A holder is live if its heartbeat is fresh. Two ways it can be declared dead:
//
//   stale heartbeat  — older than the threshold. The only signal available about
//                      ANOTHER machine, since its pids mean nothing here. This is
//                      what stops a killed run from blocking every following night.
//   dead pid         — only trusted for OUR OWN machine id, where a pid is real.
//                      kill(pid, 0) on a foreign machine's pid would be answering a
//                      question about a completely unrelated local process.
const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const machine = require('./machine');
const config = require('./config');

const PROFILE = 'profile-lock';
const SEMAPHORE = 'host-semaphore';

const nowIso = () => new Date().toISOString();
const staleMinutes = () => Number(config().lockStaleMinutes);

// A guard refused the run. `guard` is the whole point: the caller's response to
// "another machine holds this profile" (wait, or run a different persona) is nothing
// like its response to "this host is already running a browser session" (wait, or
// use the other machine).
class GuardRefusedError extends Error {
  constructor({ guard, message, holder, heartbeatAgeSeconds, path: lockPath }) {
    super(message);
    this.name = 'GuardRefusedError';
    this.guard = guard;
    this.holder = holder;
    this.heartbeatAgeSeconds = heartbeatAgeSeconds;
    this.lockPath = lockPath;
  }
  // The shape src/cli.js renders as JSON.
  toDetail() {
    return {
      guard: this.guard,
      holder: this.holder,
      heartbeatAgeSeconds: this.heartbeatAgeSeconds,
      staleAfterSeconds: staleMinutes() * 60,
    };
  }
}

function lockPath(name) {
  return paths.lock(name);
}
const profileLockPath = (profileKey) => lockPath(`${profileKey}.lock`);
const semaphorePath = (machineId) => lockPath(`host-${machineId || machine.id()}.sem`);

function readLock(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// 0600: a lock records a hostname and pid, and lives in the owner-only state dir.
function writeLock(file, record) {
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort off POSIX */ }
  return record;
}

const ageSeconds = (iso) => {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return Infinity;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
};

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user. Alive.
    return e.code === 'EPERM';
  }
}

// Is an existing lock still holding? Returns why, so a refusal or a reclaim can say
// what it observed.
//   { live, reason, ageSeconds, sameMachine }
function assess(record) {
  const age = ageSeconds(record.heartbeatAt || record.acquiredAt);
  const sameMachine = record.machineId === machine.id();
  const stale = age > staleMinutes() * 60;

  if (stale) return { live: false, reason: 'stale-heartbeat', ageSeconds: age, sameMachine };
  // A pid is only meaningful on the machine that owns it.
  if (sameMachine && !pidAlive(record.pid)) {
    return { live: false, reason: 'dead-pid', ageSeconds: age, sameMachine };
  }
  return { live: true, reason: 'held', ageSeconds: age, sameMachine };
}

function describeHolder(record) {
  return {
    machineId: record.machineId || null,
    hostname: record.hostname || null,
    pid: record.pid === undefined ? null : record.pid,
    roundId: record.roundId || null,
    persona: record.persona || null,
    profileKey: record.profileKey || null,
    acquiredAt: record.acquiredAt || null,
    heartbeatAt: record.heartbeatAt || null,
  };
}

// Take a lock file, or throw GuardRefusedError.
function take({ file, guard, record, refuse }) {
  paths.locksDir();
  const existing = readLock(file);
  if (existing) {
    const state = assess(existing);
    if (state.live) {
      throw new GuardRefusedError({
        guard,
        message: refuse(describeHolder(existing), state),
        holder: describeHolder(existing),
        heartbeatAgeSeconds: state.ageSeconds,
        path: file,
      });
    }
    // Reclaimable: record what was overridden so the reason is not lost.
    record.reclaimedFrom = { ...describeHolder(existing), reason: state.reason };
  }
  return writeLock(file, record);
}

// ─── profile lock ──────────────────────────────────────────────────────────

// acquireProfile({ profileKey, roundId, persona }) -> lock record
function acquireProfile({ profileKey, roundId = '', persona = '' } = {}) {
  if (!profileKey) throw new Error('acquireProfile: profileKey is required');
  const { profileSiblings } = require('../personas');
  const file = profileLockPath(profileKey);
  return take({
    file,
    guard: PROFILE,
    record: {
      guard: PROFILE,
      profileKey,
      persona,
      roundId,
      machineId: machine.id(),
      hostname: machine.hostname(),
      pid: process.pid,
      acquiredAt: nowIso(),
      heartbeatAt: nowIso(),
    },
    refuse: (holder, state) => {
      const who = holder.machineId === machine.id() ? 'this machine' : `machine ${holder.machineId}`;
      const siblings = profileSiblings(profileKey);
      const shared = siblings.length > 1 ? ` Profile "${profileKey}" is shared by: ${siblings.join(', ')}.` : '';
      return `another run holds the browser profile "${profileKey}" — held by ${who}`
        + `${holder.hostname && holder.machineId !== machine.id() ? ` (${holder.hostname})` : ''}`
        + `${holder.persona ? ` running ${holder.persona}` : ''}`
        + `${holder.roundId ? `, round ${holder.roundId}` : ''}`
        + `, pid ${holder.pid}, heartbeat ${state.ageSeconds}s ago.${shared}`;
    },
  });
}

// ─── host semaphore ────────────────────────────────────────────────────────

// One browser run per host, whatever the persona.
function acquireHost({ roundId = '', persona = '', profileKey = '' } = {}) {
  const file = semaphorePath();
  return take({
    file,
    guard: SEMAPHORE,
    record: {
      guard: SEMAPHORE,
      machineId: machine.id(),
      hostname: machine.hostname(),
      pid: process.pid,
      roundId,
      persona,
      profileKey,
      acquiredAt: nowIso(),
      heartbeatAt: nowIso(),
    },
    refuse: (holder, state) => (
      `this host is already running a browser session`
      + `${holder.persona ? ` (${holder.persona}` : ' ('}${holder.roundId ? `, round ${holder.roundId}` : ''})`
      + `, pid ${holder.pid}, heartbeat ${state.ageSeconds}s ago.`
      + ' One browser run per machine: two Chrome sessions on one host degrade each other.'
    ),
  });
}

// ─── both, in a fixed order ────────────────────────────────────────────────

// Always profile-then-host, and release the profile lock if the host refuses, so a
// refusal never leaves a half-held pair. A fixed order is also what makes deadlock
// between the two impossible.
function acquireAll({ profileKey, roundId = '', persona = '' } = {}) {
  const profile = acquireProfile({ profileKey, roundId, persona });
  try {
    const host = acquireHost({ roundId, persona, profileKey });
    return { profile, host };
  } catch (e) {
    releaseProfile({ profileKey, roundId });
    throw e;
  }
}

// ─── heartbeat ─────────────────────────────────────────────────────────────

// Refresh both guards for a round. Keyed on the ROUND, not the pid, because the
// process that holds a lock is not always the one doing the work: scripts/
// run-persona.sh opens the round, run-loop.js runs the batches, and src/index.js
// children do the actual browsing. Any of them may beat, so long as it is the same
// round — otherwise a long batch would let another machine declare the lock stale
// mid-application.
function heartbeat({ profileKey, roundId } = {}) {
  const beaten = [];
  for (const file of [profileKey ? profileLockPath(profileKey) : null, semaphorePath()]) {
    if (!file) continue;
    const rec = readLock(file);
    if (!rec) continue;
    if (roundId && rec.roundId && rec.roundId !== roundId) continue;
    if (rec.machineId !== machine.id() && rec.guard === SEMAPHORE) continue;
    rec.heartbeatAt = nowIso();
    try { writeLock(file, rec); beaten.push(rec.guard); } catch { /* best effort */ }
  }
  return beaten;
}

// Adopt the guards for a round into THIS process.
//
// `round start` runs in a short-lived process that exits immediately, so the pid it
// recorded is dead within a second and the lock would look reclaimable while the run
// it guards is only just beginning. The process that actually runs the browser takes
// the pid over, which restores dead-pid detection as a real signal.
function adopt({ profileKey, roundId } = {}) {
  const adopted = [];
  for (const file of [profileKey ? profileLockPath(profileKey) : null, semaphorePath()]) {
    if (!file) continue;
    const rec = readLock(file);
    if (!rec) continue;
    if (rec.machineId !== machine.id()) continue;          // never adopt another host's lock
    if (roundId && rec.roundId && rec.roundId !== roundId) continue;
    rec.pid = process.pid;
    rec.adoptedAt = nowIso();
    rec.heartbeatAt = nowIso();
    try { writeLock(file, rec); adopted.push(rec.guard); } catch { /* best effort */ }
  }
  return adopted;
}

// ─── release ───────────────────────────────────────────────────────────────

// Only remove a lock this machine holds — and, when a round id is given, only that
// round's. Releasing indiscriminately would let an aborting run delete the lock of a
// healthy run on the other machine.
function releaseFile(file, { roundId, force = false } = {}) {
  const rec = readLock(file);
  if (!rec) return { released: false, reason: 'not-held' };
  if (!force) {
    if (rec.machineId !== machine.id()) return { released: false, reason: 'held-by-another-machine', holder: describeHolder(rec) };
    if (roundId && rec.roundId && rec.roundId !== roundId) return { released: false, reason: 'held-by-another-round', holder: describeHolder(rec) };
  }
  try { fs.rmSync(file, { force: true }); } catch { return { released: false, reason: 'unlink-failed' }; }
  return { released: true, released_from: describeHolder(rec) };
}

const releaseProfile = ({ profileKey, roundId, force } = {}) => (
  profileKey ? releaseFile(profileLockPath(profileKey), { roundId, force }) : { released: false, reason: 'no-profile-key' }
);
const releaseHost = ({ roundId, force } = {}) => releaseFile(semaphorePath(), { roundId, force });

function releaseAll({ profileKey, roundId, force } = {}) {
  return {
    profile: releaseProfile({ profileKey, roundId, force }),
    host: releaseHost({ roundId, force }),
  };
}

// ─── inspection ────────────────────────────────────────────────────────────

// Every lock present, with its liveness. Used by `round unlock --force` to print
// what it is overriding, and by doctor.
function list() {
  let names = [];
  try { names = fs.readdirSync(paths.locksDir()); } catch { names = []; }
  const out = [];
  for (const name of names) {
    if (!/\.(lock|sem)$/.test(name)) continue;
    const file = lockPath(name);
    const rec = readLock(file);
    if (!rec) continue;
    const state = assess(rec);
    out.push({
      file: name,
      path: file,
      ...describeHolder(rec),
      guard: rec.guard || (name.endsWith('.sem') ? SEMAPHORE : PROFILE),
      live: state.live,
      liveness: state.reason,
      heartbeatAgeSeconds: state.ageSeconds,
      mine: state.sameMachine,
    });
  }
  return out;
}

function inspectProfile(profileKey) {
  const rec = readLock(profileLockPath(profileKey));
  if (!rec) return null;
  return { ...describeHolder(rec), ...assess(rec) };
}
function inspectHost() {
  const rec = readLock(semaphorePath());
  if (!rec) return null;
  return { ...describeHolder(rec), ...assess(rec) };
}

// Break a lock regardless of holder, reporting exactly what was overridden. The
// report is the point: forcing off another machine's live lock is sometimes the only
// way forward after a hard crash, but it must never be silent.
function forceUnlock({ profileKey, all = false } = {}) {
  const before = list();
  const targets = all
    ? before
    : before.filter((l) => (profileKey ? l.file === `${profileKey}.lock` : false) || (l.guard === SEMAPHORE && l.mine));
  const overridden = [];
  for (const t of targets) {
    const res = releaseFile(t.path, { force: true });
    overridden.push({
      guard: t.guard,
      file: t.file,
      released: res.released,
      wasLive: t.live,
      liveness: t.liveness,
      heartbeatAgeSeconds: t.heartbeatAgeSeconds,
      holder: {
        machineId: t.machineId, hostname: t.hostname, pid: t.pid,
        roundId: t.roundId, persona: t.persona, profileKey: t.profileKey,
      },
    });
  }
  return {
    overridden,
    count: overridden.length,
    warning: overridden.some((o) => o.wasLive)
      ? 'A LIVE lock was broken. If that run is still going, two runs now share one profile and the ledger can fork — confirm the other run is dead.'
      : null,
  };
}

module.exports = {
  acquireProfile,
  acquireHost,
  acquireAll,
  heartbeat,
  adopt,
  releaseProfile,
  releaseHost,
  releaseAll,
  list,
  inspectProfile,
  inspectHost,
  forceUnlock,
  GuardRefusedError,
  PROFILE,
  SEMAPHORE,
  profileLockPath,
  semaphorePath,
  staleMinutes,
};
