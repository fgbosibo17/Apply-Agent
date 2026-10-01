const assert = require('node:assert');
// Imported explicitly rather than relying on globals: whether `beforeEach` is a
// global varies by Node version, and this repo's CI matrix spans 20/22/24.
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyResumeFile, verifyAllPersonas } = require('../src/resume/verify');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-verify-')); });

const write = (name, body) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};
// A minimal but structurally real PDF.
const PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

test('a valid PDF passes', () => {
  const r = verifyResumeFile(write('Resume.pdf', PDF));
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'ok');
  assert.ok(r.bytes > 0);
  assert.equal(r.caseExact, true);
});

test('a missing file is reported, not thrown', () => {
  const r = verifyResumeFile(path.join(dir, 'nope.pdf'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing');
  assert.match(r.detail, /does not exist/);
});

test('an empty file fails even though it exists and is readable', () => {
  const r = verifyResumeFile(write('empty.pdf', ''));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

// The case that motivates the magic number: a .docx renamed to .pdf, or a
// truncated download. Extension and stat checks both pass; content does not.
test('a non-PDF with a .pdf extension fails the magic-number check', () => {
  const r = verifyResumeFile(write('fake.pdf', 'PK\u0003\u0004 this is a zip/docx'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'notPdf');
});

test('a file shorter than the magic number fails rather than passing by accident', () => {
  const r = verifyResumeFile(write('tiny.pdf', '%PD'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'notPdf');
});

test('an unset path is reported as unset, not as missing', () => {
  for (const v of [undefined, null, '']) {
    const r = verifyResumeFile(v);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unset');
  }
});

test('a directory is not accepted as a resume', () => {
  const sub = path.join(dir, 'sub.pdf');
  fs.mkdirSync(sub);
  const r = verifyResumeFile(sub);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'notFile');
});

// macOS resolves the wrong case and Linux does not, so on a case-insensitive FS
// this must be caught as caseMismatch. On a case-sensitive FS the same input
// legitimately does not exist. Both are failures; assert it fails either way and
// that the reason is one of the two correct ones.
test('a wrong-case filename never silently succeeds', () => {
  write('Jane_Resume.pdf', PDF);
  const r = verifyResumeFile(path.join(dir, 'fope_resume.pdf'));
  assert.equal(r.ok, false, 'wrong case must not pass');
  assert.ok(['caseMismatch', 'missing'].includes(r.reason), `unexpected reason ${r.reason}`);
});

test('verifyAllPersonas aggregates and names the failing persona', () => {
  const good = write('good.pdf', PDF);
  const res = verifyAllPersonas({
    secondary: { resumePath: good },
    primary: { resumePath: path.join(dir, 'gone.pdf') },
    adjacent: { resumePath: write('bad.pdf', 'nope') },
  });
  assert.equal(res.ok, false);
  assert.equal(res.failures.length, 2);
  assert.deepEqual(res.failures.map((f) => f.persona).sort(), ['adjacent', 'primary']);
  assert.equal(res.personas.find((p) => p.persona === 'secondary').ok, true);
});

test('verifyAllPersonas is ok only when every persona is ok', () => {
  const good = write('good.pdf', PDF);
  const res = verifyAllPersonas({ secondary: { resumePath: good }, primary: { resumePath: good } });
  assert.equal(res.ok, true);
  assert.equal(res.failures.length, 0);
});
