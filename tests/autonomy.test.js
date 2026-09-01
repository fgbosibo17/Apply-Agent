const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { useTempState, resetState } = require('./helpers');
useTempState();
const autonomy = require('../src/core/autonomy');

beforeEach(() => resetState());

test('the default mode is review-each with no grant', () => {
  const s = autonomy.status();
  assert.equal(s.mode, 'review-each');
  assert.equal(s.granted, false);
});

test('a grant is time-boxed and capped', () => {
  const g = autonomy.grant({ mode: 'routine-auto', hours: 999 });
  assert.equal(g.hours, 24);
  assert.ok(new Date(g.expiresAt) > new Date());
  assert.equal(autonomy.status().mode, 'routine-auto');
});

test('an expired grant falls back to review-each', () => {
  autonomy.grant({ mode: 'routine-auto', hours: 1 });
  const past = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
  const s = autonomy.status(past);
  assert.equal(s.expired, true);
  assert.equal(s.mode, 'review-each');
});

test('an invalid mode is rejected', () => {
  assert.throws(() => autonomy.grant({ mode: 'yolo' }), /mode must be one of/);
});

test('canAutoSubmit requires routine-auto, a review gate and autoEligible', () => {
  assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true }).allowed, false);
  autonomy.grant({ mode: 'routine-auto' });
  assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true }).allowed, true);
  assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: false }).allowed, false);
  assert.equal(autonomy.canAutoSubmit({ gate: 'ask', autoEligible: true }).allowed, false);
});

test('a scoped grant does not leak to another persona or past its cap', () => {
  autonomy.grant({ mode: 'routine-auto', persona: 'qa', maxSubmissions: 5 });
  assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true, persona: 'qa' }).allowed, true);
  assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true, persona: 'cloud' }).allowed, false);
  assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true, persona: 'qa', submittedThisRound: 5 }).allowed, false);
});

test('revoke drops the grant', () => {
  autonomy.grant({ mode: 'routine-auto' });
  assert.equal(autonomy.revoke().granted, false);
});

test('the always-stop list is exposed and non-empty in every mode', () => {
  autonomy.grant({ mode: 'routine-auto' });
  assert.ok(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true }).alwaysStop.length >= 5);
});
