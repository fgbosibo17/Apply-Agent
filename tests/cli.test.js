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
  const round = run(['round', 'start', '--stdin'], { persona: 'qa', target: 5 });
  assert.equal(run(['round', 'status', round.out.id]).out.remaining, 5);
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
