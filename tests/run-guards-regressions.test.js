// Regressions found by running the server setup end to end on a fresh Linux box.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { useTempState, resetState } = require('./helpers');

useTempState();

const locks = require('../src/core/locks');
const machine = require('../src/core/machine');
const config = require('../src/core/config');
const preflight = require('../src/core/preflight');
const personasModule = require('../src/personas');

const REPO = path.resolve(__dirname, '..');
const ENVELOPE = path.join(REPO, 'scripts', 'lib', 'envelope.sh');

beforeEach(() => {
  resetState();
  machine.reset();
  delete process.env.APPLY_AGENT_HOST_BROWSER_SLOTS;
  config.reset();
});

// ── the envelope must hand piped payloads to --stdin commands ──────────────

function inEnvelope(snippet) {
  return spawnSync('bash', ['-c', `. "${ENVELOPE}"; ${snippet}`], { cwd: REPO, encoding: 'utf8' });
}

test('json_stdin and logged_stdin pass a piped payload through', () => {
  const r = inEnvelope(`printf '{"persona":"primary"}' | json_stdin cat`);
  assert.equal(r.stdout, '{"persona":"primary"}');
});

test('plain json still shields commands from stdin, so they can never hang on a terminal', () => {
  const r = inEnvelope(`printf 'payload' | json cat`);
  assert.equal(r.stdout, '');
});

test('every --stdin command in the envelope is called through a stdin-preserving helper', () => {
  const lines = fs.readFileSync(ENVELOPE, 'utf8').split('\n');
  const offenders = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /--stdin/.test(l) && !/^\s*#/.test(l))
    .filter(([, l]) => /\b(logged|json)\s/.test(l) && !/\b(logged_stdin|json_stdin)\b/.test(l));
  assert.deepEqual(offenders, [], `--stdin through a /dev/null helper drops the payload: ${JSON.stringify(offenders)}`);
});

// ── host semaphore slots ───────────────────────────────────────────────────

test('one host slot by default: a second browser run on this host is refused', () => {
  assert.equal(locks.hostSlots(), 1);
  locks.acquireHost({ roundId: 'rnd_a', persona: 'primary' });
  assert.throws(() => locks.acquireHost({ roundId: 'rnd_b', persona: 'secondary' }),
    (e) => e instanceof locks.GuardRefusedError && e.guard === locks.SEMAPHORE);
});

test('APPLY_AGENT_HOST_BROWSER_SLOTS=2 allows exactly two browser runs, and frees the right slot', () => {
  process.env.APPLY_AGENT_HOST_BROWSER_SLOTS = '2';
  config.reset();
  assert.equal(locks.hostSlots(), 2);
  const a = locks.acquireHost({ roundId: 'rnd_a', persona: 'primary' });
  const b = locks.acquireHost({ roundId: 'rnd_b', persona: 'primary2' });
  assert.deepEqual([a.slot, b.slot], [1, 2]);
  assert.throws(() => locks.acquireHost({ roundId: 'rnd_c', persona: 'primary3' }),
    (e) => e.guard === locks.SEMAPHORE && /2 browser sessions, its limit/.test(e.message));

  locks.releaseHost({ roundId: 'rnd_a' });
  assert.ok(fs.existsSync(locks.semaphorePath(undefined, 2)), 'releasing round a leaves round b holding slot 2');
  const c = locks.acquireHost({ roundId: 'rnd_c', persona: 'primary3' });
  assert.equal(c.slot, 1, 'the freed slot is reused');
});

test('heartbeat and adopt find a round in any slot', () => {
  process.env.APPLY_AGENT_HOST_BROWSER_SLOTS = '2';
  config.reset();
  locks.acquireHost({ roundId: 'rnd_a', persona: 'primary' });
  locks.acquireHost({ roundId: 'rnd_b', persona: 'primary2' });
  assert.deepEqual(locks.heartbeat({ roundId: 'rnd_b' }), [locks.SEMAPHORE]);
  assert.deepEqual(locks.adopt({ roundId: 'rnd_b' }), [locks.SEMAPHORE]);
});

test('PARALLEL_SESSIONS sets the default slot count', () => {
  const before = { ...personasModule.PARALLEL_SESSIONS };
  personasModule.PARALLEL_SESSIONS.primary = 3;
  try {
    assert.equal(locks.hostSlots(), 3);
  } finally {
    for (const k of Object.keys(personasModule.PARALLEL_SESSIONS)) delete personasModule.PARALLEL_SESSIONS[k];
    Object.assign(personasModule.PARALLEL_SESSIONS, before);
  }
});

// ── unconfigured (template) personas ───────────────────────────────────────

const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
function realResume() {
  const p = path.join(process.env.APPLY_AGENT_STATE_DIR, 'Real_Resume.pdf');
  fs.writeFileSync(p, PDF);
  return p;
}
const placeholder = { resumePath: '/repo/Resume/<Your_Resume.pdf>', email: '<you@example.com>', browserProfile: '/repo/browser-profile-x' };
const ioWith = (personas) => ({
  personas,
  verifyResume: (p) => (fs.existsSync(p) ? { ok: true, bytes: 10 } : { ok: false, reason: 'missing', detail: `file does not exist: ${p}` }),
  exists: () => true,
  readdir: () => ['Default'],
});

test('a leftover example persona warns but does not block a round for a set-up persona', () => {
  const io = ioWith({
    primary: { resumePath: realResume(), email: 'a@example.com', browserProfile: '/p/primary' },
    secondary: placeholder,
  });
  const resumes = preflight.checkResumes(io, null, 'primary');
  assert.deepEqual(resumes.filter((c) => c.status === 'fail'), []);
  assert.equal(resumes.find((c) => c.name === 'resume:secondary').status, 'warn');
});

test('a round AS an unconfigured persona is refused', () => {
  const io = ioWith({ primary: placeholder });
  const fail = preflight.checkResumes(io, null, 'primary').find((c) => c.status === 'fail');
  assert.ok(fail, 'running a placeholder persona must fail');
  assert.equal(fail.name, 'persona:primary');
});

test('doctor fails when no persona at all is set up', () => {
  const io = ioWith({ primary: placeholder, secondary: placeholder });
  const fail = preflight.checkResumes(io, null, null).find((c) => c.status === 'fail');
  assert.equal(fail && fail.name, 'persona:any');
});

test('routing survives deleting the example personas', () => {
  const { personas, routePersona } = personasModule;
  const saved = { adjacent: personas.adjacent, secondary: personas.secondary };
  delete personas.adjacent;
  delete personas.secondary;
  const keep = personas.primary.matchKeywords;
  personas.primary.matchKeywords = /Backend Engineer/i;
  try {
    assert.equal(routePersona('Senior Backend Engineer'), 'primary');
    assert.equal(routePersona('Chef'), null);
  } finally {
    personas.primary.matchKeywords = keep;
    Object.assign(personas, saved);
  }
});
