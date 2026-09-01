const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { useTempState, resetState } = require('./helpers');
useTempState();
const autonomy = require('../src/core/autonomy');
const config = require('../src/core/config');

beforeEach(() => resetState());

// Run a body with defaultAutonomyMode forced, then restore. config() memoises,
// so the cache has to be reset on the way in AND out.
function withDefaultMode(mode, fn) {
  const prev = process.env.APPLY_AGENT_DEFAULT_AUTONOMY_MODE;
  process.env.APPLY_AGENT_DEFAULT_AUTONOMY_MODE = mode;
  config.reset();
  try { fn(); } finally {
    if (prev === undefined) delete process.env.APPLY_AGENT_DEFAULT_AUTONOMY_MODE;
    else process.env.APPLY_AGENT_DEFAULT_AUTONOMY_MODE = prev;
    config.reset();
  }
}

// With no grant the mode is whatever config says the DEFAULT is — not a constant.
// core/config.js ships 'routine-auto' deliberately (this agent is run by its own
// candidate, at volume); ALWAYS_STOP and the score `ask` gate are the guardrails
// that hold in every mode. Both settings are pinned here so a change to that
// default is a deliberate act rather than a silent one.
test('with no grant the mode is the configured default, and nothing is granted', () => {
  const s = autonomy.status();
  assert.equal(s.mode, config().defaultAutonomyMode);
  assert.equal(s.granted, false);
  assert.equal(s.expired, false);
});

test('the shipped default is routine-auto', () => {
  assert.equal(config.DEFAULTS.defaultAutonomyMode, 'routine-auto');
});

test('configuring review-each restores per-application approval', () => {
  withDefaultMode('review-each', () => {
    assert.equal(autonomy.status().mode, 'review-each');
    assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true }).allowed, false);
  });
});

test('a grant is time-boxed and capped', () => {
  const g = autonomy.grant({ mode: 'routine-auto', hours: 999 });
  assert.equal(g.hours, 24);
  assert.ok(new Date(g.expiresAt) > new Date());
  assert.equal(autonomy.status().mode, 'routine-auto');
});

// An expired grant must not keep its escalated mode: it falls back to the
// configured default. Asserted against review-each so the fallback is observable
// (falling back to routine-auto while the grant also said routine-auto would
// prove nothing).
test('an expired grant falls back to the configured default', () => {
  withDefaultMode('review-each', () => {
    autonomy.grant({ mode: 'routine-auto', hours: 1 });
    const past = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    const s = autonomy.status(past);
    assert.equal(s.expired, true);
    assert.equal(s.granted, false);
    assert.equal(s.mode, 'review-each');
  });
});

test('an invalid mode is rejected', () => {
  assert.throws(() => autonomy.grant({ mode: 'yolo' }), /mode must be one of/);
});

test('canAutoSubmit requires routine-auto, a review gate and autoEligible', () => {
  // review-each refuses even a perfect candidate...
  withDefaultMode('review-each', () => {
    assert.equal(autonomy.canAutoSubmit({ gate: 'review', autoEligible: true }).allowed, false);
  });
  // ...and routine-auto still refuses anything but an autoEligible review gate.
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
