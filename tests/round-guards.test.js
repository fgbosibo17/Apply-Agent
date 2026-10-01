// The guards as `round start` / `round complete` actually apply them.
//
// tests/locks.test.js covers the lock mechanics. This covers the wiring: that a round
// takes both guards before it is recorded, releases them on success AND on abort, and
// that a refusal names which guard refused — "another machine holds this profile" and
// "this host is already running a browser session" need different responses from the
// caller.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTempState, resetState, machineRunner } = require('./helpers');

useTempState();

const rounds = require('../src/core/rounds');
const locks = require('../src/core/locks');
const machine = require('../src/core/machine');
const ledger = require('../src/core/ledger');

let dir;
let profileDir;
beforeEach(() => {
  resetState();
  machine.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-guards-'));
  profileDir = path.join(dir, 'browser-profile');
  fs.mkdirSync(profileDir);
  fs.writeFileSync(path.join(profileDir, 'Local State'), '{}');
});

const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

// A healthy machine with two personas sharing one profile (primary+adjacent) and one
// on its own (secondary) — the real shape of this repo.
function ready() {
  const resume = path.join(dir, 'r.pdf');
  fs.writeFileSync(resume, PDF);
  const qaProfile = path.join(dir, 'browser-profile-secondary');
  fs.mkdirSync(qaProfile, { recursive: true });
  fs.writeFileSync(path.join(qaProfile, 'Local State'), '{}');
  return {
    io: machineRunner({
      personas: {
        secondary: { resumePath: resume, browserProfile: qaProfile, profileKey: 'secondary', email: 'a@example.com' },
        primary: { resumePath: resume, browserProfile: profileDir, profileKey: 'primary', email: 'b@example.com' },
        adjacent: { resumePath: resume, browserProfile: profileDir, profileKey: 'primary', email: 'b@example.com' },
      },
      virtualPaths: { '/usr/bin/google-chrome': true, [profileDir]: true, [qaProfile]: true },
      listings: { [profileDir]: ['Default', 'Local State'], [qaProfile]: ['Default', 'Local State'] },
      verifyResume: require('../src/resume/verify').verifyResumeFile,
    }),
  };
}
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const FOREIGN = 'runner-deadbeef';
function rewrite(file, changes) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, ...changes }, null, 2), { mode: 0o600 });
}

// ─── acquisition on start ──────────────────────────────────────────────────

test('round start takes both guards and stamps the round id into them', () => {
  const r = rounds.start({ persona: 'primary', target: 5 }, ready());
  assert.equal(r.profileKey, 'primary');
  assert.equal(r.machineId, machine.id());

  const held = locks.inspectProfile('primary');
  assert.equal(held.roundId, r.id, 'the lock names the round holding it');
  assert.equal(held.machineId, machine.id());
  assert.equal(locks.inspectHost().roundId, r.id);
});

test('a round is not recorded when a guard refuses it', () => {
  const r1 = rounds.start({ persona: 'primary' }, ready());
  rewrite(locks.profileLockPath('primary'), { machineId: FOREIGN, hostname: 'runner', pid: 4242 });
  // Free the semaphore so the PROFILE lock is unambiguously the thing refusing.
  fs.rmSync(locks.semaphorePath(), { force: true });

  assert.throws(() => rounds.start({ persona: 'adjacent' }, ready()), locks.GuardRefusedError);
  assert.deepEqual(rounds.list().map((x) => x.id), [r1.id], 'a refused round must leave no record');
});

// ─── which guard refused ───────────────────────────────────────────────────

test('a foreign profile holder refuses with the profile-lock guard, naming machine and heartbeat age', () => {
  rounds.start({ persona: 'primary' }, ready());
  rewrite(locks.profileLockPath('primary'), {
    machineId: FOREIGN, hostname: 'runner', pid: 4242, heartbeatAt: minutesAgo(3),
  });
  fs.rmSync(locks.semaphorePath(), { force: true });

  assert.throws(() => rounds.start({ persona: 'adjacent' }, ready()), (err) => {
    assert.equal(err.guard, locks.PROFILE);
    assert.equal(err.holder.machineId, FOREIGN);
    assert.equal(err.holder.hostname, 'runner');
    assert.ok(err.heartbeatAgeSeconds >= 170);
    const detail = err.toDetail();
    assert.equal(detail.guard, 'profile-lock');
    assert.ok(detail.staleAfterSeconds > 0, 'the caller can tell how long until it goes stale');
    return true;
  });
});

test('a busy host refuses with the host-semaphore guard, even for a different profile', () => {
  rounds.start({ persona: 'primary' }, ready());
  assert.throws(() => rounds.start({ persona: 'secondary' }, ready()), (err) => {
    assert.equal(err.guard, locks.SEMAPHORE, 'secondary has its own profile; the HOST is what is busy');
    assert.match(err.message, /already running a browser session/);
    return true;
  });
});

test('the two refusals are distinguishable without parsing prose', () => {
  rounds.start({ persona: 'primary' }, ready());
  let semGuard;
  try { rounds.start({ persona: 'secondary' }, ready()); } catch (e) { semGuard = e.guard; }

  rewrite(locks.profileLockPath('primary'), { machineId: FOREIGN, pid: 4242 });
  fs.rmSync(locks.semaphorePath(), { force: true });
  let profileGuard;
  try { rounds.start({ persona: 'adjacent' }, ready()); } catch (e) { profileGuard = e.guard; }

  assert.equal(semGuard, 'host-semaphore');
  assert.equal(profileGuard, 'profile-lock');
  assert.notEqual(semGuard, profileGuard);
});

// ─── cross-machine matrix ──────────────────────────────────────────────────

test('the same profile on a different machine is refused', () => {
  rounds.start({ persona: 'primary' }, ready());
  rewrite(locks.profileLockPath('primary'), { machineId: FOREIGN, pid: 4242 });
  fs.rmSync(locks.semaphorePath(), { force: true });
  assert.throws(() => rounds.start({ persona: 'primary' }, ready()), locks.GuardRefusedError);
});

test('a different profile on a different machine is allowed', () => {
  rounds.start({ persona: 'primary' }, ready());
  // The other machine holds primary; its semaphore is its own and does not travel.
  rewrite(locks.profileLockPath('primary'), { machineId: FOREIGN, pid: 4242 });
  fs.renameSync(locks.semaphorePath(), locks.semaphorePath(FOREIGN));
  rewrite(locks.semaphorePath(FOREIGN), { machineId: FOREIGN, pid: 4242 });

  const secondary = rounds.start({ persona: 'secondary', target: 3 }, ready());
  assert.ok(secondary.id, 'secondary on this machine is unaffected by the server running primary');
  assert.equal(secondary.profileKey, 'secondary');
});

test('same machine, dead pid: the next round reclaims and runs', () => {
  const first = rounds.start({ persona: 'primary' }, ready());
  rewrite(locks.profileLockPath('primary'), { pid: 999999 });
  rewrite(locks.semaphorePath(), { pid: 999999 });

  const second = rounds.start({ persona: 'adjacent' }, ready());
  assert.notEqual(second.id, first.id);
  assert.equal(locks.inspectProfile('primary').roundId, second.id);
});

// ─── release ───────────────────────────────────────────────────────────────

test('round complete releases both guards', () => {
  const r = rounds.start({ persona: 'primary', target: 2 }, ready());
  const done = rounds.complete({ id: r.id });
  assert.ok(done.completedAt);
  assert.equal(locks.inspectProfile('primary'), null);
  assert.equal(locks.inspectHost(), null);
  // The next run gets straight in.
  assert.ok(rounds.start({ persona: 'adjacent' }, ready()).id);
});

test('an abort releases both guards through rounds.release', () => {
  const r = rounds.start({ persona: 'primary' }, ready());
  // What src/index.js and src/run-loop.js do on SIGTERM / uncaught exception.
  rounds.release({ roundId: r.id, profileKey: r.profileKey });
  assert.equal(locks.inspectProfile('primary'), null);
  assert.equal(locks.inspectHost(), null);
  assert.ok(rounds.start({ persona: 'primary' }, ready()).id, 'the next night is not blocked');
});

test('release works from the round id alone, without being told the profile', () => {
  const r = rounds.start({ persona: 'adjacent' }, ready());
  rounds.release({ roundId: r.id });
  assert.equal(locks.inspectProfile('primary'), null, 'resolved adjacent -> primary profile from the round record');
});

test('a completed round leaves nothing held even if complete is called twice', () => {
  const r = rounds.start({ persona: 'primary' }, ready());
  rounds.complete({ id: r.id });
  assert.doesNotThrow(() => rounds.complete({ id: r.id }));
  assert.deepEqual(locks.list(), []);
});

// ─── heartbeat through the round ───────────────────────────────────────────

test('rounds.heartbeat keeps a long round from being declared stale', () => {
  const r = rounds.start({ persona: 'primary' }, ready());
  rewrite(locks.profileLockPath('primary'), { heartbeatAt: minutesAgo(locks.staleMinutes() + 1) });
  assert.equal(locks.inspectProfile('primary').live, false);

  rounds.heartbeat({ roundId: r.id, profileKey: r.profileKey });
  assert.equal(locks.inspectProfile('primary').live, true);
});

// ─── the machine stamp ─────────────────────────────────────────────────────

test('every ledger row carries the machine that wrote it', () => {
  const r = rounds.start({ persona: 'primary' }, ready());
  const row = ledger.add({
    company: 'Acme', role: 'Cloud Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
    persona: 'primary', roundId: r.id, confirmation: 'received',
  });
  assert.equal(row.machineId, machine.id());
  assert.equal(ledger.applications()[0].machineId, machine.id());
});

test('an explicit machineId on a ledger entry is preserved, so synced rows keep their origin', () => {
  const row = ledger.add({
    url: 'https://boards.greenhouse.io/acme/jobs/2', confirmation: 'received', machineId: FOREIGN,
  });
  assert.equal(row.machineId, FOREIGN);
});

test('the round record names the machine that opened it', () => {
  const r = rounds.start({ persona: 'primary' }, ready());
  assert.equal(r.machineId, machine.id());
  assert.ok(r.hostname);
  assert.equal(rounds.status(r.id).machineId, machine.id());
});
