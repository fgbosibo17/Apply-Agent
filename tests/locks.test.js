// The two run guards.
//
// Two machines share one logical ledger, and the ledger is what stops the same job
// being applied to twice. Two uncoordinated runs fork history and silently defeat
// dedup — silently being the problem: nothing about the second run looks wrong.
//
// The guards answer different questions and the tests are grouped that way:
//
//   PROFILE LOCK   cross-machine correctness. Keyed on the browser profile
//                  DIRECTORY, so primary and adjacent (one identity, one account)
//                  exclude each other everywhere, while secondary runs alongside either.
//   HOST SEMAPHORE local resources. One browser run per machine, any persona.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const { useTempState, resetState } = require('./helpers');

useTempState();

const locks = require('../src/core/locks');
const machine = require('../src/core/machine');
const config = require('../src/core/config');
const { personas, profileKeyFor, profileSiblings } = require('../src/personas');

beforeEach(() => {
  resetState();
  machine.reset();      // re-mint the id: the state dir it was cached in is gone
  config.reset();
});

// Rewrite a lock file to look like it belongs to someone else. Simulating the other
// machine by editing the record is the only way to test cross-machine behaviour in
// one process, and it is faithful: a foreign lock IS just a file with a different
// machineId, which is exactly what arrives over S3.
function rewriteLock(file, changes) {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...rec, ...changes }, null, 2), { mode: 0o600 });
  return { ...rec, ...changes };
}
const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();
const FOREIGN = 'runner-deadbeef';

// ─── fresh acquisition ─────────────────────────────────────────────────────

test('a fresh profile lock records the holder, and the file is 0600', () => {
  const rec = locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  assert.equal(rec.profileKey, 'primary');
  assert.equal(rec.machineId, machine.id());
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.roundId, 'rnd_1');
  assert.ok(rec.acquiredAt && rec.heartbeatAt, 'an ISO heartbeat is recorded');
  assert.doesNotThrow(() => new Date(rec.heartbeatAt).toISOString());

  const file = locks.profileLockPath('primary');
  assert.ok(fs.existsSync(file));
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
});

test('the lock lives under .state/locks and is named for the profile, not the persona', () => {
  locks.acquireProfile({ profileKey: 'primary', persona: 'adjacent' });
  assert.match(locks.profileLockPath('primary'), /[\\/]locks[\\/]primary\.lock$/);
  assert.ok(fs.existsSync(locks.profileLockPath('primary')));
});

test('a fresh host semaphore records this machine', () => {
  const rec = locks.acquireHost({ roundId: 'rnd_1', persona: 'secondary' });
  assert.equal(rec.machineId, machine.id());
  assert.equal(rec.pid, process.pid);
  const mode = fs.statSync(locks.semaphorePath()).mode & 0o777;
  assert.equal(mode, 0o600);
});

// ─── the profile lock excludes the right things ────────────────────────────

test('primary and adjacent share one profile, so one excludes the other', () => {
  assert.equal(profileKeyFor('primary'), profileKeyFor('adjacent'), 'precondition: same profile');
  locks.acquireProfile({ profileKey: profileKeyFor('primary'), roundId: 'rnd_cloud', persona: 'primary' });

  // A adjacent run on ANOTHER machine must be refused: same Chrome profile, and two
  // live sessions for one identity can invalidate each other.
  rewriteLock(locks.profileLockPath('primary'), { machineId: FOREIGN, hostname: 'runner', pid: 4242 });
  assert.throws(
    () => locks.acquireProfile({ profileKey: profileKeyFor('adjacent'), roundId: 'rnd_fs', persona: 'adjacent' }),
    (err) => {
      assert.ok(err instanceof locks.GuardRefusedError);
      assert.equal(err.guard, locks.PROFILE);
      assert.match(err.message, /primary/);
      return true;
    }
  );
});

test('secondary has its own profile and runs alongside a held primary profile', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_cloud', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { machineId: FOREIGN, pid: 4242 });
  // Different directory, different account — nothing to contend for.
  assert.doesNotThrow(() => locks.acquireProfile({ profileKey: profileKeyFor('secondary'), roundId: 'rnd_qa', persona: 'secondary' }));
});

test('a different profile is allowed across machines', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_a', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { machineId: FOREIGN, hostname: 'runner', pid: 999999 });
  const secondary = locks.acquireProfile({ profileKey: 'secondary', roundId: 'rnd_b', persona: 'secondary' });
  assert.equal(secondary.machineId, machine.id());
  // Both locks coexist.
  const held = locks.list().filter((l) => l.guard === locks.PROFILE).map((l) => l.file).sort();
  assert.deepEqual(held, ['primary.lock', 'secondary.lock']);
});

// ─── foreign refusal ───────────────────────────────────────────────────────

test('a live lock from another machine is refused, naming holder, machine and heartbeat age', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_remote', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), {
    machineId: FOREIGN, hostname: 'runner', pid: 4242, heartbeatAt: minutesAgo(2),
  });

  assert.throws(() => locks.acquireProfile({ profileKey: 'primary', persona: 'primary' }), (err) => {
    assert.equal(err.guard, locks.PROFILE);
    assert.equal(err.holder.machineId, FOREIGN);
    assert.equal(err.holder.hostname, 'runner');
    assert.equal(err.holder.pid, 4242);
    assert.equal(err.holder.roundId, 'rnd_remote');
    assert.ok(err.heartbeatAgeSeconds >= 110 && err.heartbeatAgeSeconds <= 130, `age was ${err.heartbeatAgeSeconds}`);
    // The message has to be readable on its own — it is what reaches a chat client.
    assert.match(err.message, new RegExp(FOREIGN));
    assert.match(err.message, /heartbeat \d+s ago/);
    return true;
  });
});

// A foreign pid must never be probed: pid 4242 on the server has nothing to do with
// pid 4242 here, and treating it as ours would reclaim a live lock.
test('another machine\'s dead-looking pid is NOT grounds to reclaim', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_remote', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), {
    machineId: FOREIGN, pid: 2, heartbeatAt: minutesAgo(1),      // pid 2 is not this run
  });
  assert.throws(() => locks.acquireProfile({ profileKey: 'primary' }), locks.GuardRefusedError);
});

// ─── stale reclaim ─────────────────────────────────────────────────────────

test('same machine with a dead pid is stale and reclaimable', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_dead', persona: 'primary' });
  // A pid that has certainly exited, still on this machine, heartbeat recent.
  rewriteLock(locks.profileLockPath('primary'), { pid: 999999, heartbeatAt: minutesAgo(1) });

  const rec = locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_new', persona: 'primary' });
  assert.equal(rec.roundId, 'rnd_new');
  assert.equal(rec.pid, process.pid);
  assert.ok(rec.reclaimedFrom, 'what was overridden is recorded');
  assert.equal(rec.reclaimedFrom.reason, 'dead-pid');
  assert.equal(rec.reclaimedFrom.roundId, 'rnd_dead');
});

// The only signal available about another machine, and what stops a killed run from
// blocking every following night.
test('a stale heartbeat is reclaimable even from another machine', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_old', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), {
    machineId: FOREIGN, pid: 4242, heartbeatAt: minutesAgo(locks.staleMinutes() + 5),
  });
  const rec = locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_tonight' });
  assert.equal(rec.reclaimedFrom.reason, 'stale-heartbeat');
  assert.equal(rec.reclaimedFrom.machineId, FOREIGN);
});

test('a heartbeat just inside the threshold is still live', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_live', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), {
    machineId: FOREIGN, pid: 4242, heartbeatAt: minutesAgo(locks.staleMinutes() - 1),
  });
  assert.throws(() => locks.acquireProfile({ profileKey: 'primary' }), locks.GuardRefusedError);
});

test('heartbeat refresh keeps a long run alive past the threshold', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_long', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { heartbeatAt: minutesAgo(locks.staleMinutes() + 1) });
  assert.equal(locks.inspectProfile('primary').live, false, 'stale before the beat');

  const beaten = locks.heartbeat({ profileKey: 'primary', roundId: 'rnd_long' });
  assert.ok(beaten.includes(locks.PROFILE));
  assert.equal(locks.inspectProfile('primary').live, true, 'live after the beat');
});

test('a heartbeat for a different round does not refresh someone else\'s lock', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_mine', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { heartbeatAt: minutesAgo(locks.staleMinutes() + 1) });
  locks.heartbeat({ profileKey: 'primary', roundId: 'rnd_someone_else' });
  assert.equal(locks.inspectProfile('primary').live, false, 'must remain stale');
});

// ─── the host semaphore ────────────────────────────────────────────────────

test('a second browser run on the same host is refused by the semaphore, whatever the persona', () => {
  locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  // A DIFFERENT profile, so the profile lock would allow it. The host would not.
  assert.throws(() => locks.acquireAll({ profileKey: 'secondary', roundId: 'rnd_2', persona: 'secondary' }), (err) => {
    assert.equal(err.guard, locks.SEMAPHORE);
    assert.match(err.message, /this host is already running a browser session/);
    assert.match(err.message, /degrade each other/);
    return true;
  });
});

test('a semaphore refusal does not leave the profile lock held', () => {
  locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  assert.throws(() => locks.acquireAll({ profileKey: 'secondary', roundId: 'rnd_2', persona: 'secondary' }), locks.GuardRefusedError);
  assert.equal(locks.inspectProfile('secondary'), null, 'the secondary lock taken on the way in must be rolled back');
});

// The semaphore is per-host, so it must not travel: the other machine's browser
// session is no reason to refuse this one.
test('another machine\'s semaphore does not block this host', () => {
  locks.acquireHost({ roundId: 'rnd_remote', persona: 'primary' });
  const foreignSem = locks.semaphorePath(FOREIGN);
  fs.renameSync(locks.semaphorePath(), foreignSem);
  fs.writeFileSync(foreignSem, JSON.stringify({
    guard: locks.SEMAPHORE, machineId: FOREIGN, hostname: 'runner', pid: 4242,
    roundId: 'rnd_remote', acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });

  assert.doesNotThrow(() => locks.acquireHost({ roundId: 'rnd_local', persona: 'secondary' }));
});

test('a dead pid frees the semaphore for the next run on this host', () => {
  locks.acquireHost({ roundId: 'rnd_dead', persona: 'primary' });
  rewriteLock(locks.semaphorePath(), { pid: 999999 });
  const rec = locks.acquireHost({ roundId: 'rnd_next', persona: 'secondary' });
  assert.equal(rec.roundId, 'rnd_next');
  assert.equal(rec.reclaimedFrom.reason, 'dead-pid');
});

// ─── release ───────────────────────────────────────────────────────────────

test('releaseAll frees both guards', () => {
  locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  const res = locks.releaseAll({ profileKey: 'primary', roundId: 'rnd_1' });
  assert.equal(res.profile.released, true);
  assert.equal(res.host.released, true);
  assert.equal(locks.inspectProfile('primary'), null);
  assert.equal(locks.inspectHost(), null);
  // And the next run gets in.
  assert.doesNotThrow(() => locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_2', persona: 'adjacent' }));
});

test('release refuses to remove another machine\'s lock', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { machineId: FOREIGN, pid: 4242 });
  const res = locks.releaseProfile({ profileKey: 'primary', roundId: 'rnd_1' });
  assert.equal(res.released, false);
  assert.equal(res.reason, 'held-by-another-machine');
  assert.ok(fs.existsSync(locks.profileLockPath('primary')), 'an aborting run must not free a healthy foreign lock');
});

test('release refuses to remove another round\'s lock on this machine', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_current', persona: 'primary' });
  const res = locks.releaseProfile({ profileKey: 'primary', roundId: 'rnd_other' });
  assert.equal(res.released, false);
  assert.equal(res.reason, 'held-by-another-round');
});

// ─── adoption ──────────────────────────────────────────────────────────────
// `round start` exits immediately, so its pid is dead within a second. The process
// that runs the browser takes the pid over, which is what makes dead-pid detection
// mean anything.

test('adopt takes the pid over for the same round on the same machine', () => {
  locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { pid: 999999 });
  const adopted = locks.adopt({ profileKey: 'primary', roundId: 'rnd_1' });
  assert.ok(adopted.includes(locks.PROFILE));
  const held = locks.inspectProfile('primary');
  assert.equal(held.pid, process.pid);
  assert.equal(held.live, true);
});

test('adopt never takes over another machine\'s lock', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { machineId: FOREIGN, pid: 4242 });
  locks.adopt({ profileKey: 'primary', roundId: 'rnd_1' });
  assert.equal(locks.inspectProfile('primary').pid, 4242, 'unchanged');
});

// ─── force unlock ──────────────────────────────────────────────────────────

test('forceUnlock breaks a foreign live lock and reports what it overrode', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_remote', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { machineId: FOREIGN, hostname: 'runner', pid: 4242 });

  const res = locks.forceUnlock({ profileKey: 'primary' });
  assert.equal(res.count, 1);
  const o = res.overridden[0];
  assert.equal(o.guard, locks.PROFILE);
  assert.equal(o.released, true);
  assert.equal(o.wasLive, true);
  assert.equal(o.holder.machineId, FOREIGN);
  assert.equal(o.holder.roundId, 'rnd_remote');
  // Breaking a LIVE lock is exactly how the ledger forks, so it must not be quiet.
  assert.match(res.warning, /LIVE lock was broken/);
  assert.equal(locks.inspectProfile('primary'), null);
});

test('forceUnlock on a stale lock reports no warning', () => {
  locks.acquireProfile({ profileKey: 'primary', roundId: 'rnd_old', persona: 'primary' });
  rewriteLock(locks.profileLockPath('primary'), { heartbeatAt: minutesAgo(locks.staleMinutes() + 10) });
  const res = locks.forceUnlock({ profileKey: 'primary' });
  assert.equal(res.overridden[0].wasLive, false);
  assert.equal(res.warning, null);
});

test('forceUnlock --all clears every guard', () => {
  locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  const res = locks.forceUnlock({ all: true });
  assert.equal(res.count, 2);
  assert.deepEqual(locks.list(), []);
});

// ─── inspection ────────────────────────────────────────────────────────────

test('list reports each guard with its liveness and whether it is ours', () => {
  locks.acquireAll({ profileKey: 'primary', roundId: 'rnd_1', persona: 'primary' });
  const all = locks.list();
  assert.equal(all.length, 2);
  const profile = all.find((l) => l.guard === locks.PROFILE);
  const sem = all.find((l) => l.guard === locks.SEMAPHORE);
  assert.equal(profile.live, true);
  assert.equal(profile.mine, true);
  assert.equal(profile.liveness, 'held');
  assert.equal(sem.roundId, 'rnd_1');
});

// ─── the machine id ────────────────────────────────────────────────────────

test('the machine id is stable across calls and cached on disk', () => {
  const first = machine.id();
  machine.reset();
  assert.equal(machine.id(), first, 'a re-read must not mint a new id');
  const rec = JSON.parse(fs.readFileSync(require('../src/core/paths').machine(), 'utf8'));
  assert.equal(rec.machineId, first);
  assert.ok(rec.hostname);
  assert.ok(rec.createdAt);
  const mode = fs.statSync(require('../src/core/paths').machine()).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the machine id carries the hostname and a random suffix', () => {
  assert.match(machine.id(), /^[a-z0-9-]+-[0-9a-f]{8}$/);
});

test('personas sharing an identity share a profile, and the siblings are reported', () => {
  // The refusal message names them, so a refused adjacent run can say primary holds it.
  assert.deepEqual(profileSiblings('primary').sort(), ['adjacent', 'primary']);
  assert.deepEqual(profileSiblings('secondary'), ['secondary']);
  assert.equal(personas.primary.browserProfile, personas.adjacent.browserProfile);
  assert.notEqual(personas.secondary.browserProfile, personas.primary.browserProfile);
});
