const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const { useTempState, resetState } = require('./helpers');
const stateDir = useTempState();

const BIN = path.resolve(__dirname, '..', 'bin', 'apply-agent.js');

function run(args, input) {
  const env = { ...process.env, APPLY_AGENT_STATE_DIR: stateDir, APPLY_AGENT_SECRET_BACKEND: 'file' };
  try {
    return { ok: true, out: JSON.parse(execFileSync(process.execPath, [BIN, ...args], { input: input ? JSON.stringify(input) : '', encoding: 'utf8', env })) };
  } catch (e) {
    return { ok: false, out: JSON.parse(e.stdout || '{}'), status: e.status };
  }
}

beforeEach(() => resetState());

test('help prints usage without touching state', () => {
  const text = execFileSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' });
  assert.match(text, /apply-agent <command>/);
});

test('an unknown command fails with JSON on stdout', () => {
  const r = run(['nope']);
  assert.equal(r.ok, false);
  assert.match(r.out.error, /unknown command/);
});

test('score round-trips through stdin', () => {
  const r = run(['score', '--stdin'], {
    job: { title: 'Senior SDET', postingStatus: 'active', eligible: true, workMode: 'Remote', compensationMax: 150000, mustHaves: [{ status: 'met' }, { status: 'met' }] },
    profile: { targetSeniority: ['senior'], compensationFloor: 95000, workModes: ['remote'] },
  });
  assert.equal(r.out.gate, 'review');
  assert.equal(r.out.autoEligible, true);
});

test('ledger add records, then refuses the same job a second time', () => {
  const entry = { company: 'Acme', role: 'Senior SDET', url: 'https://boards.greenhouse.io/acme/jobs/7', confirmation: 'Application received' };
  const first = run(['ledger', 'add', '--stdin'], entry);
  assert.equal(first.out.recorded, true);
  const second = run(['ledger', 'add', '--stdin'], entry);
  assert.equal(second.ok, false);
  assert.match(second.out.error, /hard duplicate/);
});

test('profile stores, checks and returns one field at a time', () => {
  const set = run(['profile', 'set', '--stdin'], { fullName: 'Test Person', email: 't@example.com' });
  assert.equal(set.out.fields, 2);
  const check = run(['profile', 'check']);
  assert.equal(check.out.present, true);
  assert.ok(check.out.missing.includes('phoneFull'));
  assert.equal(run(['profile', 'field', 'email']).out.value, 't@example.com');
  assert.equal(run(['profile', 'field', 'password']).ok, false);
});

test('profile refuses to store a secret-shaped field', () => {
  const r = run(['profile', 'set', '--stdin'], { fullName: 'X', linkedinPassword: 'hunter2' });
  assert.equal(r.ok, false);
  assert.match(r.out.error, /refusing to store sensitive field/);
});

test('autonomy, attention and round commands are reachable end to end', () => {
  // With no grant the CLI reports the configured default (core/config.js ships
  // routine-auto), not a hardcoded mode.
  assert.equal(run(['autonomy', 'status']).out.mode, require('../src/core/config')().defaultAutonomyMode);
  assert.equal(run(['autonomy', 'grant', '--stdin'], { mode: 'routine-auto', hours: 2 }).out.mode, 'routine-auto');
  assert.equal(run(['autonomy', 'revoke']).out.granted, false);
  run(['attention', 'add', '--stdin'], { kind: 'captcha', url: 'https://x.example/1' });
  assert.equal(run(['attention', 'list']).out.length, 1);

  // `round start` runs preflight's blocking subset, so its outcome depends on the
  // machine running the test. Both outcomes are part of the contract and both are
  // asserted: CI has no Chrome, no installed deps and no resumes (they are
  // gitignored), so there it must REFUSE with structured JSON and a remedy. A
  // developer machine that is actually ready starts the round.
  const round = run(['round', 'start', '--stdin'], { persona: 'secondary', target: 5 });
  if (round.ok) {
    assert.equal(run(['round', 'status', round.out.id]).out.remaining, 5);
  } else {
    assert.equal(round.status, 1, 'a refusal must exit non-zero');
    assert.match(round.out.error, /preflight failed/);
    assert.ok(Array.isArray(round.out.failures) && round.out.failures.length > 0);
    for (const f of round.out.failures) {
      assert.ok(f.name && f.detail, 'each failure names the check and what is wrong');
      assert.equal(typeof f.remedy, 'string');
    }
    assert.equal(run(['round', 'list']).out.length, 0, 'a refused round is not recorded');
  }
});

test('doctor emits JSON with a check list and a host block', () => {
  const r = run(['doctor']);
  const report = r.out;
  assert.equal(typeof report.ok, 'boolean');
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);
  for (const c of report.checks) {
    assert.ok(c.name, 'every check is named');
    assert.ok(['pass', 'fail', 'warn', 'skip'].includes(c.status), `bad status ${c.status}`);
    assert.equal(typeof c.blocking, 'boolean');
  }
  assert.ok(report.host.platform && report.host.node && report.host.checkedAt);
  assert.equal(typeof report.summary.blocking, 'number');
  // Exit status must agree with the verdict, so `doctor && npm run apply` is safe.
  assert.equal(r.ok, report.ok);
  assert.equal(report.ok, report.summary.blocking === 0);
  // Every blocking failure carries a remedy — bootstrap.sh prints these verbatim.
  for (const b of report.blocking) assert.ok(b.remedy, `${b.name} has no remedy`);
});

test('doctor rejects an unknown persona instead of silently checking everything', () => {
  const r = run(['doctor', '--persona', 'nope']);
  assert.equal(r.ok, false);
  assert.match(r.out.error, /unknown persona/);
});

test('sources list filters the local catalog', () => {
  const all = run(['sources', 'list']).out;
  assert.ok(all.length > 5);
  const api = run(['sources', 'list', '--stdin'], { kinds: ['ats-api'] }).out;
  assert.ok(api.every((s) => s.kind === 'ats-api'));
});

test('malformed stdin is reported, not swallowed', () => {
  const env = { ...process.env, APPLY_AGENT_STATE_DIR: stateDir };
  try {
    execFileSync(process.execPath, [BIN, 'score', '--stdin'], { input: '{not json', encoding: 'utf8', env });
    assert.fail('should have exited non-zero');
  } catch (e) {
    assert.match(JSON.parse(e.stdout).error, /not valid JSON/);
  }
});
