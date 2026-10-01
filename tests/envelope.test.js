// The envelope: state sync, and the failure contract every entry point must honour.
//
// Three ways in — a schedule, a chat command, a human at a keyboard — sharing one
// envelope. The two invariants worth testing here are the ones a wrapper script is
// easiest to get wrong:
//
//   1. STDOUT IS ALWAYS A VALID DIGEST. A crashed run that reports nothing is worse than
//      one that reports failing, because the orchestrator cannot tell it from a hang.
//   2. BROWSER PROFILES NEVER TRAVEL. A synced profile is one machine's device
//      fingerprint replayed on another, which is precisely what anti-bot scoring flags.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { useTempState, resetState } = require('./helpers');

const stateDir = useTempState();
const digest = require('../src/core/digest');
const stateSync = require('../src/core/state-sync');
const rounds = require('../src/core/rounds');
const progress = require('../src/core/progress');
const machine = require('../src/core/machine');
const queues = require('../src/core/queues');

const BIN = path.resolve(__dirname, '..', 'bin', 'apply-agent.js');
const ROOT = path.resolve(__dirname, '..');

beforeEach(() => {
  resetState();
  machine.reset();
  delete process.env.APPLY_AGENT_STATE_S3;
  delete process.env.APPLY_AGENT_STATE_S3_PROFILE;
});

const run = (args, env = {}) => {
  const res = execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', cwd: ROOT, input: '',
    env: { ...process.env, APPLY_AGENT_STATE_DIR: stateDir, ...env },
  });
  return JSON.parse(res);
};

// ── the failure contract ───────────────────────────────────────────────────

test('a failure with no round still produces a complete digest envelope', () => {
  const d = digest.failureEnvelope({ stage: 'doctor', error: 'blocking failure', persona: 'secondary' });
  for (const k of ['schema', 'generatedAt', 'round', 'counts', 'tailoring', 'attention', 'friction', 'blocked', 'host', 'needsAttention', 'failure']) {
    assert.ok(k in d, `missing ${k}`);
  }
  assert.equal(d.failure.failed, true);
  assert.equal(d.failure.stage, 'doctor');
  assert.equal(d.round.id, null);
  assert.equal(d.round.persona, 'secondary');
  assert.equal(d.needsAttention, true, 'a failed run always needs a human');
});

test('a failure WITH a round preserves the counts it reached', () => {
  const r = rounds.start({ persona: 'secondary', target: 5 }, { preflight: false, schema: false });
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  progress.recordJob(r.id, { status: 'Skipped', company: 'Globex' });

  const d = digest.failureEnvelope({ roundId: r.id, stage: 'apply', error: 'browser died' });
  assert.equal(d.round.id, r.id);
  assert.equal(d.counts.applied, 1, 'not zeroed — this is what it managed before failing');
  assert.equal(d.counts.skipped, 1);
  assert.equal(d.failure.stage, 'apply');
  assert.equal(d.needsAttention, true);
});

test('digest-failure emits parseable JSON through the CLI', () => {
  const d = run(['digest-failure', '--stage', 'git-pull', '--error', 'branch has diverged', '--persona', 'primary']);
  assert.equal(d.failure.stage, 'git-pull');
  assert.match(d.failure.error, /diverged/);
  assert.equal(d.round.persona, 'primary');
});

// The bug this pins: `[sub, ...args].filter(Boolean)` dropped an empty flag VALUE, so
// `--round '' --persona secondary` read "--persona" as the round id.
test('an empty --round value does not swallow the next flag', () => {
  const d = run(['digest-failure', '--stage', 'doctor', '--error', 'x', '--round', '', '--persona', 'secondary']);
  assert.equal(d.round.id, null, 'an empty round is no round');
  assert.equal(d.round.persona, 'secondary', 'the persona flag survives');
});

test('every digest timestamp is ISO 8601 with an explicit offset', () => {
  const r = rounds.start({ persona: 'secondary' }, { preflight: false, schema: false });
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  queues.attentionAdd({ kind: 'captcha', url: 'https://x/1', roundId: r.id, summary: 'needs a human' });
  const d = digest.forRound(r.id);

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  const stamps = [d.generatedAt, d.round.startedAt, d.counts.lastUpdateAt, d.attention.items[0].raisedAt];
  for (const s of stamps) assert.match(s, iso, `not ISO 8601 with an offset: ${s}`);
  // The orchestrator runs UTC and the operator is US Central, so a bare local timestamp
  // would be ambiguous by a number of hours.
  assert.ok(stamps.every((s) => /Z$|[+-]\d{2}:\d{2}$/.test(s)));
});

// ── state sync ─────────────────────────────────────────────────────────────

test('sync is skipped, not failed, when no bucket is configured', () => {
  const pulled = stateSync.pull();
  assert.equal(pulled.skipped, true);
  assert.equal(pulled.configured, false);
  const pushed = stateSync.push();
  assert.equal(pushed.skipped, true);
});

// A synced profile is one machine's OS and device fingerprint replayed on another — the
// exact mismatch CAPTCHA scoring looks for. There is no correct reason to do it.
test('a payload naming a browser profile is refused outright', () => {
  assert.throws(() => stateSync.assertNoProfiles(['/repo/browser-profile-secondary']), /never copied between machines/);
  assert.throws(() => stateSync.assertNoProfiles(['s3://b/state/', '/repo/browser-profile-primary/Default']), /browser profile/);
  assert.doesNotThrow(() => stateSync.assertNoProfiles(['/repo/.state', 's3://b/state/']));
});

// Sharing a machine id would make each host treat the other's lock as its own and reclaim
// it on a locally-dead pid — two runs on one profile, ledger forked.
test('machine identity, locks and stop signals are excluded from every sync', () => {
  assert.ok(stateSync.EXCLUDES.includes('machine.json'), 'machine id must not travel');
  assert.ok(stateSync.EXCLUDES.some((e) => e.startsWith('locks/')), 'locks describe one host');
  assert.ok(stateSync.EXCLUDES.some((e) => e.startsWith('stop/')), 'stop signals address one process');
});

test('sync status reports without touching the network', () => {
  const st = stateSync.status();
  assert.equal(st.configured, false);
  assert.equal(st.stateDir, path.resolve(stateDir));
  assert.ok('localFiles' in st && 'schema' in st);
  assert.match(st.note, /APPLY_AGENT_STATE_S3/);
});

test('state pull runs the schema gate and refuses newer state', () => {
  const schema = require('../src/core/schema');
  fs.writeFileSync(require('../src/core/paths').schema(), JSON.stringify({ version: schema.CODE_VERSION + 1 }), { mode: 0o600 });
  // Unconfigured pull still reports the schema position rather than hiding it.
  const res = stateSync.pull();
  assert.equal(res.skipped, true);
  assert.equal(res.schema.relation, 'state-newer');
});

// ── the scripts themselves ─────────────────────────────────────────────────

const sh = (script, args, env = {}) => {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf8', cwd: ROOT, input: '',
      env: { ...process.env, APPLY_AGENT_STATE_DIR: stateDir, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: (e.stdout || '') + '', stderr: (e.stderr || '') + '' };
  }
};

test('nightly-run refuses more than one persona', () => {
  const r = sh('scripts/nightly-run.sh', ['secondary', 'primary']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /one persona per invocation/);
  assert.match(r.stderr, /orchestrator decides the rotation/);
  assert.equal(r.stdout.trim(), '', 'usage goes to stderr, never stdout');
});

test('nightly-run and go both require a persona', () => {
  for (const s of ['scripts/nightly-run.sh', 'scripts/go.sh']) {
    const r = sh(s, []);
    assert.equal(r.code, 2, s);
    assert.equal(r.stdout.trim(), '', `${s}: stdout must stay clean`);
  }
});

// The safeguard is the flag and nothing else: no env var, no config default.
test('nightly-run defaults to a dry run and go does not', () => {
  const nightly = fs.readFileSync(path.join(ROOT, 'scripts/nightly-run.sh'), 'utf8');
  const go = fs.readFileSync(path.join(ROOT, 'scripts/go.sh'), 'utf8');
  assert.match(nightly, /^ENV_DRY_RUN=1/m, 'the remote path must default to dry');
  assert.match(nightly, /--live\)\s+ENV_DRY_RUN=0/, '--live is the only way to submit');
  assert.match(go, /^ENV_DRY_RUN=0/m, 'the interactive path submits: a human just asked');
});

// DRY_RUN=0 is TRUTHY in JS, and util/form.js only checks presence — so passing the flag
// through as 0/1 silently made every --live run a dry run.
test('the envelope passes DRY_RUN only when dry-running, never as 0', () => {
  const env = fs.readFileSync(path.join(ROOT, 'scripts/lib/envelope.sh'), 'utf8');
  assert.doesNotMatch(env, /DRY_RUN="\$ENV_DRY_RUN"/, 'DRY_RUN=0 would turn dry-run ON');
  assert.match(env, /dry_env=\(DRY_RUN=1\)/, 'set it only when it means something');
});

test('the envelope releases the lock from an EXIT trap on every path', () => {
  const env = fs.readFileSync(path.join(ROOT, 'scripts/lib/envelope.sh'), 'utf8');
  assert.match(env, /round complete --stdin/, 'completing releases both guards');
  assert.match(env, /round unlock --force --persona/, 'and a backstop for when it cannot');
  for (const s of ['scripts/nightly-run.sh', 'scripts/go.sh']) {
    assert.match(fs.readFileSync(path.join(ROOT, s), 'utf8'), /trap finish EXIT/, s);
  }
});

test('both scripts are non-interactive: stdin is closed and git cannot prompt', () => {
  const env = fs.readFileSync(path.join(ROOT, 'scripts/lib/envelope.sh'), 'utf8');
  assert.match(env, /< \/dev\/null/, 'anything that might read stdin gets /dev/null');
  assert.match(env, /GIT_TERMINAL_PROMPT=0/, 'git must never wait for a password');
  assert.match(env, /BatchMode=yes/);
});

// An inner `round start` would be refused by this host's own semaphore, silently turning
// the apply phase into a no-op.
test('run-persona adopts an inherited ROUND_ID instead of opening a second round', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts/run-persona.sh'), 'utf8');
  assert.match(s, /using the round already open/);
  assert.match(s, /if \[ -n "\$\{ROUND_ID:-\}" \]/);
});

test('CLAUDE.md points the agent at go.sh and warns off the raw runner', () => {
  const md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(md, /npm run go -- <persona>/);
  assert.match(md, /Never call `node src\/index\.js` or `node src\/run-loop\.js` directly/);
  assert.match(md, /no profile lock/);
  assert.match(md, /no state pull\/push/);
});

test('ONBOARDING documents the second machine, including why profiles never travel', () => {
  const md = fs.readFileSync(path.join(ROOT, 'ONBOARDING.md'), 'utf8');
  assert.match(md, /## 🖥️ Running on a second machine/);
  assert.match(md, /bootstrap\.sh/);
  assert.match(md, /x11vnc/);
  assert.match(md, /NEVER copied between machines/);
  assert.match(md, /single-writer/i);
  assert.match(md, /APPLY_AGENT_STATE_S3/);
  assert.match(md, /KEPT FOREVER/);
});
