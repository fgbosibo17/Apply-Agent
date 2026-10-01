// `round start` must refuse to open a round when the machine cannot run it.
//
// It runs preflight's BLOCKING subset. These tests hold every machine check at
// healthy and vary one thing at a time, so a refusal is unambiguously attributable —
// and they exercise the real assertReady path rather than a resume-only shortcut.
//
// The failure that motivated this: a missing resume was discovered per job by a
// `.catch(() => {})` that discarded it, the form submitted with no attachment, and
// the ledger recorded a success.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { useTempState, resetState, machineRunner } = require('./helpers');

useTempState();

const rounds = require('../src/core/rounds');

let dir;
let profileDir;
beforeEach(() => {
  resetState();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-preflight-'));
  // A populated browser profile, so the profile check is never the thing failing.
  profileDir = path.join(dir, 'browser-profile');
  fs.mkdirSync(profileDir);
  fs.writeFileSync(path.join(profileDir, 'Local State'), '{}');
});

const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
const write = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

// A healthy machine whose only variable is the set of persona resume paths. The real
// verifyResumeFile runs against real temp files, so the PDF magic number, emptiness
// and case checks are all genuinely exercised.
const ready = (resumePaths) => ({
  io: machineRunner({
    personas: Object.fromEntries(Object.entries(resumePaths).map(([k, p]) => [k, { resumePath: p, browserProfile: profileDir }])),
    virtualPaths: { '/usr/bin/google-chrome': true, [profileDir]: true },
    listings: { [profileDir]: ['Default', 'Local State'] },
    verifyResume: require('../src/resume/verify').verifyResumeFile,
  }),
});

test('a round starts when every persona has a usable resume', () => {
  const good = write('good.pdf', PDF);
  const r = rounds.start({ persona: 'secondary', target: 5 }, ready({ secondary: good, primary: good, adjacent: good }));
  assert.ok(r.id, 'expected a round id');
  assert.equal(rounds.list().length, 1);
});

test('a missing resume refuses the round and names the persona', () => {
  const good = write('good.pdf', PDF);
  assert.throws(
    () => rounds.start({ persona: 'secondary' }, ready({ secondary: good, primary: path.join(dir, 'gone.pdf') })),
    (err) => {
      assert.equal(err.name, 'PreflightError');
      assert.match(err.message, /preflight failed/);
      assert.equal(err.failures.length, 1);
      assert.equal(err.failures[0].name, 'resume:primary');
      assert.match(err.failures[0].detail, /does not exist/);
      assert.ok(err.failures[0].remedy, 'a refusal must say what to do about it');
      return true;
    }
  );
  assert.equal(rounds.list().length, 0, 'no round may be recorded when preflight fails');
});

test('an empty resume file refuses the round', () => {
  assert.throws(
    () => rounds.start({ persona: 'secondary' }, ready({ secondary: write('empty.pdf', '') })),
    (err) => {
      assert.equal(err.failures[0].name, 'resume:secondary');
      assert.match(err.failures[0].detail, /empty/);
      return true;
    }
  );
  assert.equal(rounds.list().length, 0);
});

test('a non-PDF refuses the round even with a .pdf extension', () => {
  assert.throws(
    () => rounds.start({ persona: 'secondary' }, ready({ secondary: write('fake.pdf', 'PK\u0003\u0004 zip, not a pdf') })),
    (err) => {
      assert.match(err.failures[0].detail, /%PDF-/);
      return true;
    }
  );
  assert.equal(rounds.list().length, 0);
});

// A resume is a repo artifact: it travels via git, so one broken resume is broken
// everywhere and hiding it until that persona next runs means finding out overnight.
test('a resume failure in one persona refuses a round started for another', () => {
  const good = write('good.pdf', PDF);
  assert.throws(
    () => rounds.start({ persona: 'secondary' }, ready({ secondary: good, adjacent: write('bad.pdf', 'nope') })),
    /preflight failed/
  );
  assert.equal(rounds.list().length, 0);
});

test('every failing persona is reported, not just the first', () => {
  const good = write('good.pdf', PDF);
  assert.throws(
    () => rounds.start({}, ready({ secondary: good, primary: path.join(dir, 'gone.pdf'), adjacent: write('bad.pdf', 'nope') })),
    (err) => {
      assert.deepEqual(err.failures.map((f) => f.name).sort(), ['resume:adjacent', 'resume:primary']);
      return true;
    }
  );
});

// A browser profile is per-machine by design, so it is scoped to the persona being
// run. Refusing a secondary round because nobody has logged in as adjacent would ground the
// server for a reason that has nothing to do with the work in hand.
test('a round is refused when ITS persona has no browser profile', () => {
  const good = write('good.pdf', PDF);
  const opts = ready({ secondary: good });
  opts.io.personas.secondary.browserProfile = path.join(dir, 'never-logged-in');
  assert.throws(
    () => rounds.start({ persona: 'secondary' }, opts),
    (err) => {
      assert.equal(err.failures[0].name, 'profile:secondary');
      assert.match(err.failures[0].remedy, /Nobody has logged in as secondary/);
      return true;
    }
  );
});

test('another persona having no browser profile does not refuse this round', () => {
  const good = write('good.pdf', PDF);
  const opts = ready({ secondary: good, adjacent: good });
  opts.io.personas.adjacent.browserProfile = path.join(dir, 'never-logged-in');
  const r = rounds.start({ persona: 'secondary', target: 2 }, opts);
  assert.ok(r.id);
});

// A blocking machine failure that has nothing to do with resumes still refuses.
test('a machine below the disk floor refuses the round', () => {
  const good = write('good.pdf', PDF);
  const opts = ready({ secondary: good });
  opts.io.freeGb = () => 0.2;
  assert.throws(() => rounds.start({ persona: 'secondary' }, opts), (err) => {
    assert.equal(err.failures[0].name, 'disk');
    return true;
  });
  assert.equal(rounds.list().length, 0);
});

// The opt-out is a second argument for a reason: `round start --stdin` parses stdin
// into the FIRST argument, so no remote caller can disable the preflight.
test('preflight cannot be disabled through the stdin payload', () => {
  assert.throws(
    () => rounds.start({ persona: 'secondary', preflight: false }, ready({ secondary: path.join(dir, 'gone.pdf') })),
    /preflight failed/
  );
});
