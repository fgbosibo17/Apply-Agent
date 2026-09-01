const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { useTempState, resetState } = require('./helpers');
useTempState();
const queues = require('../src/core/queues');
const rounds = require('../src/core/rounds');
const ledger = require('../src/core/ledger');

beforeEach(() => resetState());

test('attention items are added, listed and resolved without rewriting history', () => {
  const a = queues.attentionAdd({ kind: 'captcha', url: 'https://x.example/jobs/1', company: 'X', summary: 'interactive challenge' });
  assert.equal(queues.attentionList().length, 1);
  queues.attentionResolve({ id: a.id, resolution: 'solved by candidate' });
  assert.equal(queues.attentionList().length, 0);
  // Append-only: the original row is still on disk.
  assert.equal(require('../src/core/ndjson').readAll(require('../src/core/paths').attention()).length, 2);
});

test('an unknown attention kind degrades to other rather than throwing mid-run', () => {
  assert.equal(queues.attentionAdd({ kind: 'made-up', url: 'https://x.example/1' }).kind, 'other');
});

test('attention requires a url', () => {
  assert.throws(() => queues.attentionAdd({ kind: 'captcha' }), /url is required/);
});

test('friction records are sanitized of URLs and aggregated by signature', () => {
  queues.frictionRecord({ area: 'ats:greenhouse', signature: 'timeout at https://boards.greenhouse.io/a/jobs/1', summary: 'x' });
  queues.frictionRecord({ area: 'ats:greenhouse', signature: 'timeout at https://boards.greenhouse.io/b/jobs/2', summary: 'x' });
  const list = queues.frictionList();
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
  assert.equal(list[0].signature, 'timeout at <url>');
});

test('a round tracks its own submissions and open attention items', () => {
  const r = rounds.start({ persona: 'qa', target: 10 });
  ledger.add({ company: 'Acme', role: 'Senior SDET', url: 'https://boards.greenhouse.io/acme/jobs/1', roundId: r.id, confirmation: 'received' });
  queues.attentionAdd({ kind: 'login-required', url: 'https://y.example/2', roundId: r.id });
  const st = rounds.status(r.id);
  assert.equal(st.submitted, 1);
  assert.equal(st.remaining, 9);
  assert.equal(st.attentionOpen, 1);
  assert.ok(rounds.complete({ id: r.id }).completedAt);
});

test('round status with no argument returns the open round', () => {
  const r = rounds.start({ persona: 'cloud', target: 3 });
  assert.equal(rounds.status().id, r.id);
});
