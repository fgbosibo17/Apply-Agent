// Schema versioning and disk guards.
//
// SCHEMA: two machines drift onto different commits while sharing one ledger over git
// and S3. Older code reading a newer row keeps the fields it recognises and writes the
// rest away — no error, nothing in a log, and the field is gone from the one file whose
// accuracy is the entire point. That loss is unrecoverable, so the asymmetry is strict:
// older code REFUSES on newer state; newer code migrates older state forward.
//
// DISK: .gitignore and .profile-archive/README.txt record this repo reaching 23
// browser-profile directories and 5.1 GB. The guards make that visible and reversible.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const { useTempState, resetState } = require('./helpers');

useTempState();

const schema = require('../src/core/schema');
const retention = require('../src/core/retention');
const profiles = require('../src/core/profiles');
const preflight = require('../src/core/preflight');
const rounds = require('../src/core/rounds');
const paths = require('../src/core/paths');
const machine = require('../src/core/machine');
const config = require('../src/core/config');

beforeEach(() => {
  resetState();
  machine.reset();
  config.reset();
});

const stamp = (version, extra = {}) => {
  paths.ensureStateDir();
  fs.writeFileSync(paths.schema(), JSON.stringify({ version, updatedAt: new Date().toISOString(), ...extra }, null, 2), { mode: 0o600 });
};

// ── the version stamp ──────────────────────────────────────────────────────

test('unstamped state reports as unstamped rather than as version zero', () => {
  const st = schema.status();
  assert.equal(st.stateVersion, null);
  assert.equal(st.relation, 'unstamped');
  assert.equal(st.stamped, false);
  assert.equal(st.match, true, 'nothing to disagree with yet');
  assert.equal(st.codeVersion, schema.CODE_VERSION);
});

test('assertCompatible stamps unstamped state at the code version', () => {
  const res = schema.assertCompatible();
  assert.equal(res.action, 'stamped');
  assert.equal(res.stateVersion, schema.CODE_VERSION);
  const onDisk = JSON.parse(fs.readFileSync(paths.schema(), 'utf8'));
  assert.equal(onDisk.version, schema.CODE_VERSION);
  assert.equal(onDisk.updatedBy, machine.id(), 'which machine stamped it');
  assert.equal(fs.statSync(paths.schema()).mode & 0o777, 0o600);
});

test('matching versions are a no-op', () => {
  stamp(schema.CODE_VERSION);
  const res = schema.assertCompatible();
  assert.equal(res.action, 'none');
  assert.equal(res.match, true);
});

// ── the refusal: older code, newer state ───────────────────────────────────

test('older code refuses newer state, and says to update the repo', () => {
  stamp(schema.CODE_VERSION + 1, { updatedBy: 'runner-a1b2c3d4' });
  assert.throws(() => schema.assertCompatible(), (err) => {
    assert.equal(err.name, 'SchemaTooOldError');
    assert.match(err.message, /refusing to run/);
    assert.match(err.message, new RegExp(`state is schema v${schema.CODE_VERSION + 1}`));
    assert.match(err.message, /git pull/);
    assert.match(err.message, /silently drop/, 'the reason, not just the rule');
    assert.equal(err.failures[0].name, 'schema');
    assert.ok(err.failures[0].remedy);
    return true;
  });
});

test('a refusal does not rewrite the stamp — the newer state is left intact', () => {
  stamp(schema.CODE_VERSION + 5);
  assert.throws(() => schema.assertCompatible());
  assert.equal(JSON.parse(fs.readFileSync(paths.schema(), 'utf8')).version, schema.CODE_VERSION + 5);
});

test('round start refuses on newer state and records no round', () => {
  stamp(schema.CODE_VERSION + 1);
  assert.throws(() => rounds.start({ persona: 'secondary' }, { preflight: false }), /refusing to run/);
  assert.equal(rounds.list().length, 0);
});

test('the schema gate runs BEFORE preflight, so the message is about the repo', () => {
  // A machine that would also fail preflight must still report the schema problem:
  // updating the repo is the first thing to do, and a preflight failure would send the
  // operator somewhere else entirely.
  stamp(schema.CODE_VERSION + 1);
  assert.throws(
    () => rounds.start({ persona: 'secondary' }, { io: { freeGb: () => 0.1 } }),
    (err) => {
      assert.equal(err.name, 'SchemaTooOldError');
      return true;
    }
  );
});

// ── migrating forward: newer code, older state ─────────────────────────────

test('newer code migrates older state forward without a flag', () => {
  stamp(1, { updatedBy: 'old-laptop' });
  const res = schema.assertCompatible({ quiet: true });
  assert.equal(res.action, 'migrated');
  assert.equal(res.from, 1);
  assert.equal(res.stateVersion, schema.CODE_VERSION);
  assert.equal(res.match, true);
});

test('the forward migration reuses the existing migrate path', () => {
  stamp(1);
  const res = schema.assertCompatible({ quiet: true });
  // migrate.js reports what it backfilled; the shape proves it ran rather than being
  // reimplemented here.
  assert.ok(res.migrated, 'migration was attempted');
  assert.ok('applications' in res.migrated && 'seen' in res.migrated);
});

test('migration can be skipped while still stamping', () => {
  stamp(1);
  const res = schema.assertCompatible({ migrate: false, quiet: true });
  assert.equal(res.action, 'migrated');
  assert.equal(res.migrated, null, 'nothing backfilled');
  assert.equal(res.stateVersion, schema.CODE_VERSION);
});

test('a round proceeds after migrating', () => {
  stamp(1);
  const r = rounds.start({ persona: 'secondary', target: 2 }, { preflight: false, schema: true });
  assert.ok(r.id);
  assert.equal(schema.status().stateVersion, schema.CODE_VERSION);
});

// ── doctor ─────────────────────────────────────────────────────────────────

test('doctor reports code version, state version and whether they match', () => {
  stamp(schema.CODE_VERSION);
  const c = preflight.checkSchema(preflight.defaultIo());
  assert.equal(c.status, 'pass');
  assert.equal(c.data.codeVersion, schema.CODE_VERSION);
  assert.equal(c.data.stateVersion, schema.CODE_VERSION);
  assert.equal(c.data.match, true);
  assert.match(c.detail, /match/);
});

test('doctor warns, without blocking, when the repo is behind', () => {
  stamp(schema.CODE_VERSION + 1);
  const c = preflight.checkSchema(preflight.defaultIo());
  assert.equal(c.status, 'warn');
  assert.equal(c.blocking, false, 'round start enforces it; doctor reports it');
  assert.match(c.detail, /OLDER than state/);
  assert.match(c.remedy, /git pull/);
});

test('doctor says older state will migrate rather than calling it a problem', () => {
  stamp(1);
  const c = preflight.checkSchema(preflight.defaultIo());
  assert.equal(c.status, 'pass');
  assert.match(c.detail, /migrate forward/);
});

// ── disk: the free-space floor ─────────────────────────────────────────────

test('a round below the disk floor is refused before it starts', () => {
  const io = { freeGb: () => 0.3 };
  assert.throws(() => rounds.start({ persona: 'secondary' }, { io }), (err) => {
    assert.equal(err.name, 'PreflightError');
    assert.ok(err.failures.some((f) => f.name === 'disk'), 'the disk check is what refused');
    return true;
  });
  assert.equal(rounds.list().length, 0, 'no round recorded, no queue slot burned');
});

test('the floor is configurable', () => {
  config.reset();
  const prev = process.env.APPLY_AGENT_DISK_FREE_FLOOR_GB;
  process.env.APPLY_AGENT_DISK_FREE_FLOOR_GB = '99999';
  config.reset();
  try {
    const c = preflight.checkDisk(preflight.defaultIo());
    assert.equal(c.status, 'fail');
    assert.equal(c.blocking, true);
    assert.equal(c.data.floorGb, 99999);
    assert.match(c.remedy, /APPLY_AGENT_DISK_FREE_FLOOR_GB/);
  } finally {
    if (prev === undefined) delete process.env.APPLY_AGENT_DISK_FREE_FLOOR_GB;
    else process.env.APPLY_AGENT_DISK_FREE_FLOOR_GB = prev;
    config.reset();
  }
});

// ── disk: profile directories ──────────────────────────────────────────────

test('profiles list classifies against the profileKeys personas own', () => {
  const state = profiles.list();
  // primary and adjacent share one key, so two keys for three personas.
  assert.deepEqual(state.knownProfileKeys.sort(), ['primary', 'secondary']);
  for (const p of state.known) {
    assert.equal(p.known, true);
    assert.ok(p.personas.length >= 1, `${p.name} should name its personas`);
  }
  assert.ok(state.totals.profiles >= state.known.length);
  assert.ok(typeof state.totals.liveMb === 'number');
});

test('a directory matching no profileKey is an orphan', () => {
  const state = profiles.list({ measureSizes: false });
  const names = new Set([...state.known, ...state.unknown].map((p) => p.name));
  // The classification is name-based, so assert the rule rather than the machine's
  // current contents: every listed dir is known iff its key is a known profileKey.
  for (const p of [...state.known, ...state.unknown]) {
    assert.equal(p.known, state.knownProfileKeys.includes(p.profileKey), p.name);
  }
  assert.ok(names.size >= 0);
});

test('prune changes nothing without --apply', () => {
  const res = profiles.prune({ apply: false });
  assert.equal(res.applied, false);
  assert.equal(res.acted, 0);
  for (const a of res.actions) assert.ok(a.would, 'each action says what it would do');
  assert.match(res.note, /Nothing changed/);
});

// Deleting the wrong directory costs a login that exists nowhere else — profiles are
// never copied between machines, so there is no backup.
test('prune refuses to touch a live profile even when named explicitly', () => {
  const res = profiles.prune({ apply: true, names: ['secondary'] });
  assert.ok(res.error, 'must refuse');
  assert.match(res.error, /live profile/);
  assert.match(res.error, /destroy a login/);
});

test('quarantine is the default and delete is opt-in', () => {
  assert.equal(profiles.prune({ apply: false }).mode, 'quarantine');
  assert.equal(profiles.prune({ apply: false, deleteInstead: true }).mode, 'delete');
});

test('the archive directory follows the existing .profile-archive convention', () => {
  assert.equal(profiles.ARCHIVE_DIRNAME, '.profile-archive');
  assert.equal(profiles.archiveDir(), path.join(paths.root, '.profile-archive'));
});

test('doctor reports the profile count and flags orphans', () => {
  const c = preflight.checkProfileDirs(preflight.defaultIo());
  assert.ok(['pass', 'warn'].includes(c.status));
  assert.equal(c.blocking, false, 'an orphan wastes disk; it does not stop a run');
  assert.match(c.detail, /live profile/);
});

// ── disk: run artifact retention ───────────────────────────────────────────

const seedArtifact = (dir, name, ageDays) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, Buffer.alloc(20000));
  const t = new Date(Date.now() - ageDays * 86400000);
  fs.utimesSync(f, t, t);
  return f;
};

test('run logs and dry-run screenshots past retention are deleted', () => {
  const oldLog = seedArtifact(paths.runLogs(), 'qa-old-batch-1.log', 40);
  const newLog = seedArtifact(paths.runLogs(), 'qa-new-batch-1.log', 1);
  const oldShot = seedArtifact(paths.dryRuns(), 'dryrun-Old.png', 40);
  const newShot = seedArtifact(paths.dryRuns(), 'dryrun-New.png', 1);

  const res = retention.gcRuns({ retentionDays: 30 });
  assert.equal(res.deletedFiles, 2);
  assert.equal(res.keptFiles, 2);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(oldShot), false);
  assert.equal(fs.existsSync(newLog), true);
  assert.equal(fs.existsSync(newShot), true);
  assert.ok(res.reclaimedBytes > 0);
});

test('run artifacts default to the same retention as rendered PDFs', () => {
  const configured = config().resumeRenderRetentionDays;
  const res = retention.gcRuns({ dryRun: true });
  assert.equal(res.retentionDays, configured, 'one number to reason about, not two');
});

test('gcRuns --dry-run reports without deleting', () => {
  const f = seedArtifact(paths.runLogs(), 'qa-old-batch-2.log', 40);
  const res = retention.gcRuns({ retentionDays: 30, dryRun: true });
  assert.equal(res.deletedFiles, 1);
  assert.equal(fs.existsSync(f), true);
});

test('gcAll sweeps both artifacts and renders, and never touches resume sources', () => {
  seedArtifact(paths.runLogs(), 'qa-old-batch-3.log', 40);
  // A tailored source, aged well past the window. It must survive: it is the only
  // record of what an employer received once the PDF is gone.
  const src = paths.resumeSource('rnd_old', 'job_abc');
  fs.writeFileSync(src, '# Jane Doe\n\ntailored');
  const old = new Date(Date.now() - 400 * 86400000);
  fs.utimesSync(src, old, old);

  const res = retention.gcAll({ retentionDays: 30 });
  assert.ok(res.runs.deletedFiles >= 1);
  assert.equal(fs.existsSync(src), true, 'sources are permanent');
  assert.match(res.note, /SOURCES are permanent/);
});

test('run artifact usage is reportable for the run header', () => {
  seedArtifact(paths.runLogs(), 'qa-usage-batch.log', 1);
  const u = retention.runArtifactUsage();
  assert.equal(u.logs.files, 1);
  assert.ok(u.logs.bytes > 0);
  assert.ok(typeof u.totalMb === 'number');
});

test('sweeping an absent directory is not an error', () => {
  const res = retention.sweepDir(path.join(paths.stateDir(), 'nope'), Date.now(), {});
  assert.equal(res.present, false);
  assert.equal(res.deleted, 0);
});
