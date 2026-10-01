// `apply-agent doctor` — machine readiness.
//
// Nothing verified that a machine could run this, so failures surfaced mid-run. The
// checks below are asserted against machines described as fixtures, which is the only
// way to assert the headless Ubuntu runner's verdict from the laptop. machineRunner()
// in tests/helpers.js is that runner's real current state.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTempState, resetState, machineIo, machineRunner, REPO_ROOT } = require('./helpers');

useTempState();
const preflight = require('../src/core/preflight');

let dir;
beforeEach(() => {
  resetState();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
});

const byName = (report, name) => report.checks.find((c) => c.name === name);
const collect = (io, opts = {}) => preflight.collect({ io, ...opts });

// ─── The runner, as it is today ─────────────────────────────────────────────

test('the Linux runner is ready', () => {
  const report = collect(machineRunner());

  assert.deepEqual(report.blocking.map((b) => b.name), [], 'nothing blocking on the runner as it stands');
  assert.equal(report.ok, true);

  assert.equal(byName(report, 'node').status, 'pass');
  assert.match(byName(report, 'node').detail, /22\.23\.2/);
  assert.equal(byName(report, 'chrome').status, 'pass');
  assert.equal(byName(report, 'xvfb').status, 'pass');
  assert.equal(byName(report, 'disk').status, 'pass');
  assert.equal(byName(report, 'profile:secondary').status, 'pass');
  assert.equal(byName(report, 'profile:primary').status, 'pass');
  assert.equal(byName(report, 'resume:adjacent').status, 'pass');
});

// adjacent has no directory of its own and needs none: it shares primary's, which is
// populated. Before profileKey it demanded a separate login for the same Google
// account — the third directory was the bug, not a missing login.
test('a persona sharing an identity needs no profile of its own', () => {
  const report = collect(machineRunner());
  assert.equal(byName(report, 'profile:adjacent'), undefined, 'not checked separately');
  assert.equal(byName(report, 'profile:primary').status, 'pass');
  // One check per directory, not per persona.
  const profileChecks = report.checks.filter((c) => c.name.startsWith('profile:'));
  assert.deepEqual(profileChecks.map((c) => c.name).sort(), ['profile:primary', 'profile:secondary']);
});

// ─── profiles grouped by identity ──────────────────────────────────────────

test('doctor reports profiles grouped by identity', () => {
  const check = byName(collect(machineRunner()), 'profile-identities');
  assert.equal(check.status, 'pass');
  const byEmail = Object.fromEntries(check.data.identities.map((g) => [g.email, g]));
  const sharedAcct = byEmail['jane.doe@example.com'];
  assert.deepEqual(sharedAcct.personas.sort(), ['adjacent', 'primary']);
  assert.equal(sharedAcct.profileDirs.length, 1, 'one account, one directory');
  assert.deepEqual(sharedAcct.profileKeys, ['primary']);
  const soloAcct = byEmail['alex.doe@example.com'];
  assert.deepEqual(soloAcct.personas, ['secondary']);
  assert.equal(check.detail.includes('primary+adjacent'), true, 'the grouping is visible in the summary');
});

// The exact state this change removed: one identity, two directories. It is the
// silent kind of wrong — both profiles work, they just log each other out.
test('doctor flags two personas with one email resolving to different profile directories', () => {
  const io = machineRunner({
    personas: {
      primary: { resumePath: 'r.pdf', browserProfile: '/repo/browser-profile-primary', profileKey: 'primary', email: 'same@example.com' },
      adjacent: { resumePath: 'r.pdf', browserProfile: '/repo/browser-profile-adjacent', profileKey: 'adjacent', email: 'same@example.com' },
    },
  });
  const check = preflight.checkProfileIdentities(io);
  assert.equal(check.status, 'warn');
  assert.equal(check.blocking, false, 'a persona-config mistake must not ground both machines');
  assert.match(check.detail, /split across multiple profile directories/);
  assert.match(check.detail, /same@example\.com/);
  assert.match(check.remedy, /same profileKey/);
  assert.equal(check.data.split.length, 1);
  assert.deepEqual(check.data.split[0].personas.sort(), ['adjacent', 'primary']);
});

test('different identities with different directories are not flagged', () => {
  const check = preflight.checkProfileIdentities(machineRunner());
  assert.deepEqual(check.data.split, []);
  assert.equal(check.status, 'pass');
});

test('the runner resolves real Chrome at /usr/bin/google-chrome, not bundled Chromium', () => {
  const chrome = byName(collect(machineRunner()), 'chrome');
  assert.equal(chrome.status, 'pass');
  assert.equal(chrome.data.path, '/usr/bin/google-chrome');
  assert.equal(chrome.data.channel, 'chrome');
  assert.match(chrome.data.version, /Google Chrome 141/);
  // The resolved path must not be Playwright's own download.
  assert.notEqual(chrome.data.path, chrome.data.bundledChromium);
  assert.match(chrome.detail, /\/usr\/bin\/google-chrome/, 'the resolved path is reported, not just a verdict');
});

test('DISPLAY unset with xvfb-run installed is the correct headless state, and says to wrap commands', () => {
  const xvfb = byName(collect(machineRunner()), 'xvfb');
  assert.equal(xvfb.status, 'pass');
  assert.equal(xvfb.data.display, null);
  assert.equal(xvfb.data.wrapRequired, true);
  assert.match(xvfb.detail, /xvfb-run -a/);
});

test('no secret-tool on the runner warns and names the file backend, without blocking', () => {
  const s = byName(collect(machineRunner()), 'secret-store');
  assert.equal(s.status, 'warn');
  assert.equal(s.blocking, false);
  assert.equal(s.data.secretTool, null);
  assert.equal(s.data.backend, 'file', 'linux without secret-tool falls back to the file backend');
  assert.match(s.remedy, /libsecret-tools/);
});

test('432 GB clears the floor', () => {
  const d = byName(collect(machineRunner()), 'disk');
  assert.equal(d.status, 'pass');
  assert.equal(d.data.freeGb, 432);
  assert.ok(d.data.floorGb > 0);
});

test('S3 is skipped, not failed, when no bucket is configured', () => {
  const s = byName(collect(machineRunner()), 's3');
  assert.equal(s.status, 'skip');
  assert.equal(s.ok, true);
  assert.equal(s.data.configured, false);
});

// The single most common new-machine failure, so its wording is asserted rather
// than left to drift.
// A machine where nobody has logged in yet — the most common new-machine failure.
function machineNoLogin(persona = 'secondary') {
  const missing = path.join(REPO_ROOT, 'browser-profile-never-logged-in');
  return machineRunner({
    personas: {
      [persona]: { resumePath: path.join(REPO_ROOT, 'Resume', 'Alex_Doe_Secondary_Resume.pdf'), browserProfile: missing, profileKey: persona, email: 'a@example.com' },
    },
    virtualPaths: { '/usr/bin/google-chrome': true, [missing]: false },
    listings: {},
  });
}

test('an absent profile says nobody has logged in and how to fix it, without copying', () => {
  const p = byName(collect(machineNoLogin('secondary')), 'profile:secondary');
  assert.equal(p.status, 'fail');
  assert.equal(p.blocking, true);
  assert.match(p.detail, /absent/);
  assert.match(p.remedy, /Nobody has logged in as secondary on this machine yet/);
  assert.match(p.remedy, /x11vnc/, 'on Linux the first login happens over x11vnc');
  assert.match(p.remedy, /[Nn]ever copy a profile/);
});

test('an EMPTY profile directory is as blocking as an absent one', () => {
  const empty = path.join(dir, 'browser-profile-secondary');
  fs.mkdirSync(empty);
  const io = machineRunner({
    personas: { secondary: { resumePath: 'x.pdf', browserProfile: empty } },
    virtualPaths: { '/usr/bin/google-chrome': true, [empty]: true },
    listings: { [empty]: [] },
  });
  const p = byName(collect(io), 'profile:secondary');
  assert.equal(p.status, 'fail');
  assert.match(p.detail, /EMPTY/);
  assert.match(p.remedy, /Nobody has logged in as secondary/);
});

// ─── Individual checks ─────────────────────────────────────────────────────

test('Node below 20 is blocking and names the required version', () => {
  const r = preflight.checkNode(machineIo({ nodeVersion: '18.19.0' }));
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.detail, /18\.19\.0 is older than the required 20/);
  assert.match(r.remedy, /nvm install/);
});

test('Node 20 and 22 both pass', () => {
  for (const v of ['20.0.0', '22.23.2', '24.1.0']) {
    assert.equal(preflight.checkNode(machineIo({ nodeVersion: v })).status, 'pass', v);
  }
});

// ─── npm ci currency ───────────────────────────────────────────────────────
// A fake repo root, so the real node_modules is never the subject.

const fakeRepo = (over = {}) => {
  const root = fs.mkdtempSync(path.join(dir, 'repo-'));
  const pkg = { dependencies: { playwright: '^1.50.0' }, ...(over.pkg || {}) };
  const lock = { packages: { 'node_modules/playwright': { version: '1.58.1' } }, ...(over.lock || {}) };
  if (over.pkg !== null) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  if (over.lock !== null) fs.writeFileSync(path.join(root, 'package-lock.json'), over.lockRaw || JSON.stringify(lock));
  if (over.installed) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    for (const [name, version] of Object.entries(over.installed)) {
      const d = path.join(root, 'node_modules', name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version }));
    }
    fs.writeFileSync(path.join(root, 'node_modules', '.package-lock.json'), '{}');
  } else if (over.installed !== null) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  }
  return root;
};

test('absent node_modules is blocking and says to run npm ci', () => {
  const r = preflight.checkNpmCi(machineIo({ root: fakeRepo({ installed: null }) }));
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.detail, /node_modules is absent/);
  assert.match(r.remedy, /npm ci/);
});

test('a missing package-lock.json is blocking', () => {
  const r = preflight.checkNpmCi(machineIo({ root: fakeRepo({ lock: null }) }));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /package-lock\.json is missing/);
});

test('an installed version that disagrees with the lock is blocking', () => {
  const root = fakeRepo({ installed: { playwright: '1.40.0' } });
  const r = preflight.checkNpmCi(machineIo({ root }));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /installed 1\.40\.0, lock pins 1\.58\.1/);
});

test('a dependency in package.json that was never installed is blocking', () => {
  const root = fakeRepo({ installed: {} });
  const r = preflight.checkNpmCi(machineIo({ root }));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /playwright: not installed/);
});

test('a matching tree passes', () => {
  const root = fakeRepo({ installed: { playwright: '1.58.1' } });
  const r = preflight.checkNpmCi(machineIo({ root }));
  assert.equal(r.status, 'pass');
});

// A git checkout can touch package-lock.json's mtime without changing a byte of it.
// Refusing rounds for that would be a false alarm, so it warns.
test('a newer lock file with matching versions only warns', () => {
  const root = fakeRepo({ installed: { playwright: '1.58.1' } });
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(root, 'package-lock.json'), future, future);
  const r = preflight.checkNpmCi(machineIo({ root }));
  assert.equal(r.status, 'warn');
  assert.equal(r.blocking, false);
  assert.equal(r.data.versionsMatch, true);
});

test('a corrupt lock file is blocking, not silently ignored', () => {
  const r = preflight.checkNpmCi(machineIo({ root: fakeRepo({ lockRaw: '{not json', installed: { playwright: '1.58.1' } }) }));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /not valid JSON/);
});

test('playwright missing from the tree is blocking', () => {
  const r = preflight.checkPlaywright(machineIo({ root: fakeRepo({ installed: {} }) }));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /playwright package is not installed/);
});

test('playwright present reports its version', () => {
  const r = preflight.checkPlaywright(machineIo({ root: fakeRepo({ installed: { playwright: '1.58.1' } }) }));
  assert.equal(r.status, 'pass');
  assert.equal(r.data.version, '1.58.1');
});

test('a machine with no real Chrome is blocking and refuses to suggest headless', () => {
  const io = machineIo({
    bins: {},
    virtualPaths: {
      '/opt/google/chrome/chrome': false, '/opt/google/chrome/google-chrome': false,
      '/usr/bin/google-chrome': false, '/usr/bin/google-chrome-stable': false,
    },
  });
  const r = preflight.checkChrome(io);
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.remedy, /never switch to headless|Never switch to headless/i);
  assert.ok(r.data.tried.length > 0, 'reports where it looked');
});

test('Chromium masquerading as the chrome channel is rejected', () => {
  const io = machineIo({
    bins: { 'google-chrome': '/usr/bin/chromium' },
    versions: { '/usr/bin/chromium --version': 'Chromium 141.0.7390.54 snap' },
    virtualPaths: {
      '/opt/google/chrome/chrome': false, '/opt/google/chrome/google-chrome': false,
      '/usr/bin/google-chrome': false, '/usr/bin/google-chrome-stable': false,
      '/usr/bin/chromium': true,
    },
  });
  const r = preflight.checkChrome(io);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /not Google Chrome/);
});

test('Chrome present but not executable is blocking, distinctly from absent', () => {
  const io = machineIo({
    bins: { 'google-chrome': '/usr/bin/google-chrome' },
    versions: { '/usr/bin/google-chrome --version': null },   // exits non-zero
    virtualPaths: { '/usr/bin/google-chrome': true },
  });
  const r = preflight.checkChrome(io);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /would not report a version/);
});

test('no xvfb-run and no DISPLAY on Linux is blocking', () => {
  const r = preflight.checkXvfb(machineIo({ bins: {}, env: {} }));
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.remedy, /apt-get install -y xvfb/);
  assert.match(r.remedy, /Do NOT set headless:true/);
});

test('no xvfb-run but a real DISPLAY only warns', () => {
  const r = preflight.checkXvfb(machineIo({ bins: {}, env: { DISPLAY: ':0' } }));
  assert.equal(r.status, 'warn');
  assert.equal(r.blocking, false);
});

test('xvfb is skipped off Linux', () => {
  const r = preflight.checkXvfb(machineIo({ platform: 'darwin' }));
  assert.equal(r.status, 'skip');
  assert.equal(r.ok, true);
});

test('secret-tool present on Linux yields the secret-service backend', () => {
  const r = preflight.checkSecretStore(machineIo({ bins: { 'secret-tool': '/usr/bin/secret-tool' } }));
  assert.equal(r.status, 'pass');
  assert.equal(r.data.backend, 'secret-service');
});

// ─── S3 ────────────────────────────────────────────────────────────────────

test('a configured bucket with no aws CLI is blocking', () => {
  const io = machineIo({ env: { APPLY_AGENT_STATE_S3: 's3://bucket/prefix' }, bins: {} });
  const r = preflight.checkS3(io);
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.remedy, /aws configure/);
});

test('a bucket that lists but refuses writes is blocking, and says why that is a trap', () => {
  const calls = [];
  const io = machineIo({
    env: { APPLY_AGENT_STATE_S3: 's3://bucket/prefix/', APPLY_AGENT_STATE_S3_PROFILE: 'runner' },
    bins: { aws: '/usr/local/bin/aws' },
    run: (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (args[1] === 'ls') return { ok: true, stdout: '2026-08-01 12:00:00 42 state.ndjson', code: 0 };
      if (args[1] === 'cp') return { ok: false, stdout: '', stderr: 'AccessDenied', code: 1 };
      return { ok: true, stdout: '', code: 0 };
    },
  });
  const r = preflight.checkS3(io);
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /can read .* but cannot write/);
  assert.match(r.remedy, /s3:PutObject/);
  assert.equal(r.data.readable, true);
  assert.ok(calls.some((c) => c.includes('--profile runner')), 'the configured profile is used');
});

test('a readable and writable bucket passes and cleans up its probe object', () => {
  const calls = [];
  const io = machineIo({
    env: { APPLY_AGENT_STATE_S3: 's3://bucket/prefix' },
    bins: { aws: '/usr/local/bin/aws' },
    run: (cmd, args) => { calls.push(args.join(' ')); return { ok: true, stdout: '', code: 0 }; },
  });
  const r = preflight.checkS3(io);
  assert.equal(r.status, 'pass');
  assert.equal(r.data.writable, true);
  assert.equal(r.data.probeCleanedUp, true);
  const rm = calls.find((c) => c.startsWith('s3 rm'));
  assert.ok(rm, 'the write probe must be deleted');
  assert.match(rm, /doctor-write-probe/);
});

// ─── Disk and ledger ───────────────────────────────────────────────────────

test('free space below the floor is blocking', () => {
  const r = preflight.checkDisk(machineIo({ freeGb: () => 0.4 }));
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.detail, /below the .* floor/);
});

test('an unreadable free-space figure warns rather than blocking work', () => {
  const r = preflight.checkDisk(machineIo({ freeGb: () => null }));
  assert.equal(r.status, 'warn');
  assert.equal(r.blocking, false);
});

test('a readable ledger reports its row count', () => {
  const f = path.join(dir, 'applications.ndjson');
  fs.writeFileSync(f, '{"id":"app_1"}\n{"id":"app_2"}\n');
  const r = preflight.checkLedger(machineIo({ ledgerFiles: () => ({ applications: f }) }));
  assert.equal(r.status, 'pass');
  assert.equal(r.data.applications.rows, 2);
});

// readAll() skips unparseable lines by design, which hides corruption from every
// other caller. Dedup reads this file, so a hole in it can mean re-applying to a job
// already submitted.
test('corruption mid-file is blocking', () => {
  const f = path.join(dir, 'applications.ndjson');
  fs.writeFileSync(f, '{"id":"app_1"}\nnot json at all\n{"id":"app_2"}\n');
  const r = preflight.checkLedger(machineIo({ ledgerFiles: () => ({ applications: f }) }));
  assert.equal(r.status, 'fail');
  assert.equal(r.blocking, true);
  assert.match(r.detail, /unparseable/);
});

test('a torn final line is tolerated, because append-only storage is built for it', () => {
  const f = path.join(dir, 'applications.ndjson');
  fs.writeFileSync(f, '{"id":"app_1"}\n{"id":"app_2","url":"https://ex');
  const r = preflight.checkLedger(machineIo({ ledgerFiles: () => ({ applications: f }) }));
  assert.equal(r.ok, true);
  assert.equal(r.status, 'warn');
  assert.match(r.detail, /torn final line/);
});

test('a missing ledger is not a failure — a new machine has never applied', () => {
  const r = preflight.checkLedger(machineIo({ ledgerFiles: () => ({ applications: path.join(dir, 'nope.ndjson') }) }));
  assert.equal(r.status, 'pass');
});

// ─── Resumes ───────────────────────────────────────────────────────────────

test('every persona resume is checked and a bad one is blocking', () => {
  const io = machineIo({
    personas: {
      secondary: { resumePath: '/r/qa.pdf', browserProfile: '/p/qa' },
      primary: { resumePath: '/r/cloud.pdf', browserProfile: '/p/cloud' },
    },
    verifyResume: (p) => (p === '/r/cloud.pdf'
      ? { ok: false, reason: 'missing', detail: 'file does not exist: /r/cloud.pdf', bytes: 0 }
      : { ok: true, reason: 'ok', detail: 'ok', bytes: 1000 }),
  });
  const checks = preflight.checkResumes(io);
  assert.deepEqual(checks.map((c) => c.name), ['resume:secondary', 'resume:primary']);
  assert.equal(checks[1].status, 'fail');
  assert.equal(checks[1].blocking, true);
});

test('a case mismatch gets the macOS-versus-Linux remedy, not a generic one', () => {
  const io = machineIo({
    personas: { secondary: { resumePath: '/r/qa.pdf', browserProfile: '/p/qa' } },
    verifyResume: () => ({ ok: false, reason: 'caseMismatch', detail: 'filename case does not match', bytes: 10 }),
  });
  const r = preflight.checkResumes(io)[0];
  assert.match(r.remedy, /resolves on macOS and fails on Linux/);
});

// ─── Composition ───────────────────────────────────────────────────────────

test('a fully healthy machine is ok with nothing blocking', () => {
  const good = path.join(dir, 'browser-profile-secondary');
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'Local State'), '{}');
  const io = machineRunner({
    personas: { secondary: { resumePath: path.join(REPO_ROOT, 'Resume', 'x.pdf'), browserProfile: good } },
    virtualPaths: { '/usr/bin/google-chrome': true, [good]: true },
    listings: { [good]: ['Default', 'Local State'] },
  });
  const report = collect(io);
  assert.equal(report.ok, true, JSON.stringify(report.blocking));
  assert.equal(report.summary.blocking, 0);
});

test('the report carries the host context an orchestrator needs', () => {
  const report = collect(machineRunner());
  assert.equal(report.host.platform, 'linux');
  assert.equal(report.host.node, '22.23.2');
  assert.equal(report.host.display, null);
  assert.ok(report.host.checkedAt);
  assert.ok(report.summary.pass > 0);
});

test('--persona narrows both resume and profile checks', () => {
  const report = collect(machineRunner(), { persona: 'secondary' });
  assert.ok(byName(report, 'resume:secondary'));
  assert.ok(byName(report, 'profile:secondary'));
  assert.equal(byName(report, 'profile:adjacent'), undefined);
  assert.equal(report.ok, true, 'narrowing past the un-logged-in persona clears the run');
});

// round start scopes profiles to the persona it is running but still checks every
// resume: a profile is per-machine by design, a resume is a repo artifact.
test('profilePersona narrows profiles while every resume is still checked', () => {
  const report = collect(machineRunner(), { profilePersona: 'secondary' });
  assert.ok(byName(report, 'resume:primary'), 'other personas resumes still checked');
  assert.ok(byName(report, 'resume:adjacent'));
  assert.equal(byName(report, 'profile:adjacent'), undefined, 'other personas profiles not checked');
  assert.equal(report.ok, true);
});

test('assertReady throws with a remedy per failure', () => {
  assert.throws(() => preflight.assertReady({ io: machineNoLogin('secondary') }), (err) => {
    assert.equal(err.name, 'PreflightError');
    assert.equal(err.failures.length, 1);
    assert.equal(err.failures[0].name, 'profile:secondary');
    assert.ok(err.failures[0].remedy.length > 0);
    return true;
  });
});

test('assertReady returns the report when the machine is ready', () => {
  const report = preflight.assertReady({ io: machineRunner(), persona: 'secondary' });
  assert.equal(report.ok, true);
});

test('the text format shows a remedy for failures and none for passes', () => {
  const text = preflight.format(collect(machineNoLogin('secondary')));
  assert.match(text, /NOT READY/);
  assert.match(text, /\[FAIL\] profile:secondary/);
  assert.match(text, /Nobody has logged in as secondary/);
  assert.match(text, /\[ok {2}\] node: Node 22\.23\.2/);
  // A passing check must not print a remedy line.
  const nodeLine = text.split('\n').findIndex((l) => l.includes('node: Node 22.23.2'));
  assert.ok(!text.split('\n')[nodeLine + 1].includes('->'));
});
