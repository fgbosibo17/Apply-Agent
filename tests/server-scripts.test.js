// The server entry points: finding node under cron's bare PATH, and the one-time
// VNC login script's refusals. Neither needs a browser or a display.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apply-agent-server-'));
}

// A PATH holding only the coreutils the helper needs (ls, sort, tail) and no node —
// cron's bare PATH, minus whatever node happens to live in /usr/bin on this machine.
function toolsOnlyPath() {
  const dir = tmpdir();
  for (const tool of ['ls', 'sort', 'tail']) {
    const where = spawnSync(BASH, ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (where) fs.symlinkSync(where, path.join(dir, tool));
  }
  return dir;
}

// Run a bash snippet with ONLY the given PATH, the way cron would.
function bashWith(env, script) {
  return spawnSync(BASH, ['-c', script], { cwd: REPO, env, encoding: 'utf8' });
}

test('ensure-node finds an nvm-installed node when cron PATH has none', () => {
  const home = tmpdir();
  for (const v of ['v18.20.0', 'v22.11.0', 'v20.9.0']) {
    const bin = path.join(home, '.nvm', 'versions', 'node', v, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho ${v}\n`, { mode: 0o755 });
  }
  const r = bashWith({ HOME: home, PATH: toolsOnlyPath(), ENSURE_NODE_DIRS: '' },
    'set -u; . scripts/lib/ensure-node.sh; command -v node; node');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /v22\.11\.0\/bin\/node/, 'the newest installed version wins');
  assert.match(r.stdout.trim().split('\n').pop(), /^v22\.11\.0$/);
});

test('ensure-node leaves an existing node alone', () => {
  const home = tmpdir();
  const bin = path.join(home, 'mybin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\necho mine\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v99.0.0', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nvm', 'versions', 'node', 'v99.0.0', 'bin', 'node'), '#!/bin/sh\necho nvm\n', { mode: 0o755 });
  const r = bashWith({ HOME: home, PATH: `${bin}:/usr/bin:/bin` }, '. scripts/lib/ensure-node.sh; node');
  assert.equal(r.stdout.trim(), 'mine');
});

test('ensure-node says what to do, and does not exit the caller, when there is no node at all', () => {
  const r = bashWith({ HOME: tmpdir(), PATH: toolsOnlyPath(), ENSURE_NODE_DIRS: '' },
    'set -u; . scripts/lib/ensure-node.sh; echo still-running');
  assert.match(r.stdout, /still-running/);
  assert.match(r.stderr, /node not found on PATH/);
  assert.match(r.stderr, /crontab/);
});

test('login-profile.sh with no persona prints usage and exits 2', () => {
  const r = spawnSync(BASH, ['scripts/login-profile.sh'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /login-profile\.sh <persona>/);
  assert.match(r.stdout, /ssh -N -L 5900:localhost:5900/);
});

test('login-profile.sh refuses an unknown persona and lists the real ones', () => {
  const r = spawnSync(BASH, ['scripts/login-profile.sh', 'nobody-by-this-name'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown persona "nobody-by-this-name"/);
  assert.match(r.stderr, /primary/);
});

test('the doctor tells a Linux server to log in with login-profile.sh', () => {
  const preflight = require('../src/core/preflight');
  const dir = path.join(tmpdir(), 'browser-profile-primary');
  const io = {
    platform: 'linux',
    personas: { primary: { resumePath: 'x.pdf', browserProfile: dir } },
    exists: () => false,
    readdir: () => [],
  };
  const [check] = preflight.checkProfiles(io);
  assert.match(check.remedy, /bash scripts\/login-profile\.sh primary/);
  assert.match(check.remedy, /x11vnc/);
  assert.match(check.remedy, /Never copy a profile/);
});

test('the laptop login helper and the runner use the same cookie-encryption flags', () => {
  const src = fs.readFileSync(path.join(REPO, 'setup-browser-login.js'), 'utf8');
  const sh = fs.readFileSync(path.join(REPO, 'scripts', 'login-profile.sh'), 'utf8');
  for (const flag of ['--password-store=basic', '--use-mock-keychain']) {
    assert.ok(src.includes(flag), `setup-browser-login.js passes ${flag}`);
    assert.ok(sh.includes(flag), `login-profile.sh passes ${flag}`);
  }
});

// ── stop-now.sh ────────────────────────────────────────────────────────────

function withState() {
  const dir = tmpdir();
  return { ...process.env, APPLY_AGENT_STATE_DIR: dir, STOP_WAIT_SEC: '1' };
}

test('stop-now.sh with nothing running says so and exits 0', () => {
  const r = spawnSync(BASH, ['scripts/stop-now.sh'], { cwd: REPO, env: withState(), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing is running/);
});

test('stop-now.sh closes a round whose run already died, without waiting on it', () => {
  const env = withState();
  // An open round with no live lock holder — what a crash leaves behind.
  const open = spawnSync(process.execPath, ['-e', `
    const rounds = require('./src/core/rounds');
    const r = rounds.start({ persona: 'primary', target: 1 }, { preflight: false, guards: false, schema: false });
    console.log(r.id);
  `], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(open.status, 0, open.stderr);
  const id = open.stdout.trim();

  const r = spawnSync(BASH, ['scripts/stop-now.sh'], { cwd: REPO, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`closing round ${id} \\(its run is no longer alive\\)`));

  const after = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify(require('./src/core/rounds').status('${id}')))`],
    { cwd: REPO, env, encoding: 'utf8' });
  const st = JSON.parse(after.stdout);
  assert.equal(st.running, false, 'the orphaned round is closed');
});
