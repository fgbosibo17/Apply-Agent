const { test } = require('node:test');
const assert = require('node:assert');
const { score, coverage } = require('../src/core/score');

const profile = {
  targetSeniority: ['senior', 'staff', 'principal'],
  compensationFloor: 95000,
  usCitizen: false,
  hasClearance: false,
  workModes: ['remote', 'hybrid'],
  excludedCompanies: ['Bad Corp'],
};
const solid = {
  title: 'Senior SDET', company: 'Acme', postingStatus: 'active', eligible: true,
  workMode: 'Remote', compensationMax: 160000, employmentType: 'Full-time',
  mustHaves: [{ status: 'met' }, { status: 'met' }, { status: 'met' }, { status: 'partial' }],
};

test('closed postings are excluded before anything is scored', () => {
  const r = score({ ...solid, postingStatus: 'closed' }, profile);
  assert.equal(r.gate, 'exclude');
  assert.equal(r.score, null);
});

test('citizenship and clearance requirements exclude when the profile cannot meet them', () => {
  assert.equal(score({ ...solid, requiresCitizenship: true }, profile).gate, 'exclude');
  assert.equal(score({ ...solid, requiresClearance: true }, profile).gate, 'exclude');
});

test('an excluded company is excluded regardless of fit', () => {
  assert.equal(score({ ...solid, company: 'Bad Corp, Inc.' }, profile).gate, 'exclude');
});

test('an incompatible work mode is excluded', () => {
  assert.equal(score({ ...solid, workMode: 'Onsite - Berlin' }, profile).gate, 'exclude');
});

test('anything unclear asks instead of guessing', () => {
  assert.equal(score({ ...solid, postingStatus: 'unclear' }, profile).gate, 'ask');
  assert.equal(score({ ...solid, mustHaves: [] }, profile).gate, 'ask');
  assert.equal(score({ ...solid, mustHaves: [{ status: 'unclear' }] }, profile).gate, 'ask');
  assert.equal(score({ ...solid, compensationAskedOfCandidate: true }, profile).gate, 'ask');
});

test('below-floor compensation and off-target seniority skip', () => {
  const r = score({ ...solid, title: 'Junior QA', seniority: 'Junior', compensationMax: 60000 }, profile);
  assert.equal(r.gate, 'skip');
  assert.ok(r.reasons.some((x) => /non-target seniority/.test(x)));
  assert.ok(r.reasons.some((x) => /below floor/.test(x)));
});

test('unknown compensation never excludes or skips on its own', () => {
  const r = score({ ...solid, compensationMax: undefined }, profile);
  assert.equal(r.gate, 'review');
});

test('a strong exact-seniority match is auto-eligible', () => {
  const r = score(solid, profile);
  assert.equal(r.gate, 'review');
  assert.ok(r.score >= 80);
  assert.equal(r.autoEligible, true);
});

test('auto-eligibility is withheld for adjacent seniority, thin evidence, or an experience mismatch', () => {
  assert.equal(score({ ...solid, title: 'Mid-level QA Engineer', seniority: 'Mid' }, profile).autoEligible, false);
  const thin = score({ ...solid, mustHaves: [{ status: 'met' }, { status: 'partial' }, { status: 'missing' }] }, profile);
  assert.equal(thin.autoEligible, false);
  assert.equal(score({ ...solid, experienceMismatch: true }, profile).autoEligible, false);
});

test('coverage counts a partial as half', () => {
  assert.equal(coverage([{ status: 'met' }, { status: 'partial' }]).ratio, 0.75);
  assert.equal(coverage([]).ratio, null);
});
