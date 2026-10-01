// Secret storage on a headless server.
//
// The runner is a display-less Ubuntu box reached over a private network, and libsecret needs
// a session keyring that a scheduled job has no access to — so secret-tool is absent
// there by design. The candidate profile must still be storable, which means falling
// back to the owner-only 0600 file backend rather than failing.
//
// That fallback is the failure-shaped one: if it silently stopped working, the
// profile would read as empty and forms would be filled from nothing.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { useTempState, resetState } = require('./helpers');

const stateDir = useTempState();
const secretStore = require('../src/core/secret-store');
const paths = require('../src/core/paths');

const BIN = path.resolve(__dirname, '..', 'bin', 'apply-agent.js');

beforeEach(() => resetState());

// ─── The fallback decision ─────────────────────────────────────────────────
// backend() takes an optional probe so the question can be asked about a machine
// other than this one; the defaults are the real process.

test('headless Linux with no secret-tool falls back to the file backend', () => {
  assert.equal(secretStore.backend({ platform: 'linux', hasSecretTool: false, env: {} }), 'file');
});

test('Linux WITH secret-tool uses the secret service, so the fallback is a fallback', () => {
  assert.equal(secretStore.backend({ platform: 'linux', hasSecretTool: true, env: {} }), 'secret-service');
});

test('the other platforms keep their OS-backed stores', () => {
  assert.equal(secretStore.backend({ platform: 'darwin', env: {} }), 'keychain');
  assert.equal(secretStore.backend({ platform: 'win32', env: {} }), 'dpapi');
});

test('an explicit backend override wins everywhere', () => {
  assert.equal(secretStore.backend({ platform: 'darwin', env: { APPLY_AGENT_SECRET_BACKEND: 'file' } }), 'file');
  assert.equal(secretStore.backend({ platform: 'linux', hasSecretTool: true, env: { APPLY_AGENT_SECRET_BACKEND: 'file' } }), 'file');
});

// ─── The file backend itself ───────────────────────────────────────────────

test('the file backend round-trips the profile and writes it 0600', () => {
  const prev = process.env.APPLY_AGENT_SECRET_BACKEND;
  process.env.APPLY_AGENT_SECRET_BACKEND = 'file';
  try {
    const res = secretStore.setProfile({ fullName: 'Test Person', email: 't@example.com' });
    assert.equal(res.backend, 'file');

    const file = paths.profile();
    assert.ok(fs.existsSync(file), 'the profile file must exist on disk');
    // Owner-only. The file holds name, email, phone and LinkedIn.
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got 0${mode.toString(8)}`);
    // And it lives in the 0700 state dir, not next to the source.
    assert.equal(path.dirname(file), path.resolve(stateDir));

    const back = secretStore.getProfile();
    assert.equal(back.fullName, 'Test Person');
    assert.equal(back.email, 't@example.com');
    assert.ok(back._storedAt, 'a stored profile is stamped');
  } finally {
    if (prev === undefined) delete process.env.APPLY_AGENT_SECRET_BACKEND;
    else process.env.APPLY_AGENT_SECRET_BACKEND = prev;
  }
});

// ─── Through the CLI ───────────────────────────────────────────────────────

// `profile check` must NAME the backend, so an operator on a new machine can tell
// where the profile went without reading source.
test('profile check reports backend "file" when the file backend is in play', () => {
  const env = {
    ...process.env,
    APPLY_AGENT_STATE_DIR: stateDir,
    APPLY_AGENT_SECRET_BACKEND: 'file',
  };
  const run = (args, input) => JSON.parse(execFileSync(process.execPath, [BIN, ...args], {
    input: input ? JSON.stringify(input) : '', encoding: 'utf8', env,
  }));

  const empty = run(['profile', 'check']);
  assert.equal(empty.backend, 'file');
  assert.equal(empty.present, false);
  assert.equal(empty.ok, false, 'no profile stored yet');
  assert.ok(empty.missing.includes('fullName'));

  run(['profile', 'set', '--stdin'], {
    fullName: 'Test Person', email: 't@example.com', phoneFull: '+1 555 0100',
    city: 'Springfield', state: 'IL', country: 'United States',
    linkedIn: 'https://linkedin.com/in/test', resumePath: 'Resume/test.pdf',
    workAuthStatus: 'Green Card / Permanent Resident',
  });

  const filled = run(['profile', 'check']);
  assert.equal(filled.backend, 'file');
  assert.equal(filled.present, true);
  assert.deepEqual(filled.missing, []);
  assert.equal(filled.ok, true);
});

// The real thing, unforced: on Linux without secret-tool the CLI must reach the file
// backend on its own, with no APPLY_AGENT_SECRET_BACKEND set. CI runs ubuntu-latest
// and has no libsecret-tools, so this is the actual runner scenario. Elsewhere the
// native answer is keychain or dpapi and there is nothing to assert — process.platform
// cannot be faked in a subprocess, which is why the decision itself is covered by the
// probe tests above.
const hasSecretTool = () => {
  try {
    execFileSync('secret-tool', ['--help'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    return e.code !== 'ENOENT' && e.status !== undefined;
  }
};

test('on headless Linux with no secret-tool, the CLI itself reports backend "file"', (t) => {
  if (process.platform !== 'linux' || hasSecretTool()) {
    t.skip(`native fallback only observable on Linux without secret-tool (here: ${process.platform}, secret-tool ${hasSecretTool() ? 'present' : 'absent'})`);
    return;
  }
  const env = { ...process.env, APPLY_AGENT_STATE_DIR: stateDir };
  delete env.APPLY_AGENT_SECRET_BACKEND;   // no override: this is the real decision
  delete env.DISPLAY;                      // headless
  const out = JSON.parse(execFileSync(process.execPath, [BIN, 'profile', 'check'], { encoding: 'utf8', env }));
  assert.equal(out.backend, 'file');
});
