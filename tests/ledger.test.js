const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { useTempState, resetState } = require('./helpers');
useTempState();
const ledger = require('../src/core/ledger');

const base = {
  company: 'Acme, Inc.',
  role: 'Senior SDET',
  url: 'https://boards.greenhouse.io/acme/jobs/123',
  persona: 'qa',
  discoverySource: 'linkedin',
  confirmation: 'Application received',
};

beforeEach(() => resetState());

test('add refuses a submission with no confirmation evidence', () => {
  assert.throws(() => ledger.add({ ...base, confirmation: '' }), /confirmation evidence is required/);
});

test('check stops on a canonical-url duplicate even when the URL differs cosmetically', () => {
  ledger.add(base);
  const r = ledger.check({ ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/123/application?utm_source=x' });
  assert.equal(r.duplicate, true);
  assert.equal(r.decision, 'stop');
  assert.ok(['canonical-url', 'employer-job-id'].includes(r.duplicateType));
});

test('check stops on an employer-job-id duplicate reached from a different path', () => {
  ledger.add(base);
  const r = ledger.check({ company: 'Acme', role: 'SDET II', url: 'https://boards.greenhouse.io/acme/jobs/123?gh_jid=123' });
  assert.equal(r.decision, 'stop');
});

test('a hard duplicate can be overridden only with the explicit token', () => {
  ledger.add(base);
  const r = ledger.check({ ...base, duplicateOverride: 'NEW REQUISITION CONFIRMED' });
  assert.equal(r.duplicate, true);
  assert.notEqual(r.decision, 'stop');
});

test('same company + same role at a different URL is an ask, not a silent apply', () => {
  ledger.add(base);
  const r = ledger.check({ company: 'Acme', role: 'Sr. SDET', url: 'https://jobs.lever.co/acme/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  assert.equal(r.duplicate, false);
  assert.ok(r.aliasMatch);
  assert.equal(r.decision, 'ask');
});

test('company reapply is gated by the cooldown and released after it', () => {
  ledger.add({ ...base, ts: new Date(Date.now() - 3 * 86400000).toISOString() });
  const soon = ledger.check({ company: 'Acme', role: 'Staff Platform Engineer', url: 'https://boards.greenhouse.io/acme/jobs/999' });
  assert.equal(soon.companyReapply, 'cooldown-active');
  assert.equal(soon.decision, 'ask');

  resetState();
  ledger.add({ ...base, ts: new Date(Date.now() - 40 * 86400000).toISOString() });
  const later = ledger.check({ company: 'Acme', role: 'Staff Platform Engineer', url: 'https://boards.greenhouse.io/acme/jobs/999' });
  assert.equal(later.companyReapply, 'eligible-after-cooldown');
  assert.equal(later.decision, 'proceed');
});

test('an existing outcome turns a reapply into a follow-up', () => {
  const app = ledger.add({ ...base, ts: new Date(Date.now() - 40 * 86400000).toISOString() });
  ledger.recordOutcome({ applicationId: app.id, outcome: 'interview' });
  const r = ledger.check({ company: 'Acme', role: 'Staff Platform Engineer', url: 'https://boards.greenhouse.io/acme/jobs/999' });
  assert.equal(r.companyReapply, 'follow-up-present');
  assert.equal(r.decision, 'ask');
});

test('outcomes are validated and idempotent', () => {
  const app = ledger.add(base);
  assert.throws(() => ledger.recordOutcome({ applicationId: app.id, outcome: 'nope' }), /outcome must be one of/);
  assert.throws(() => ledger.recordOutcome({ applicationId: 'app_missing', outcome: 'rejected' }), /unknown applicationId/);
  const first = ledger.recordOutcome({ applicationId: app.id, outcome: 'rejected', reason: 'skill-gap' });
  const again = ledger.recordOutcome({ applicationId: app.id, outcome: 'rejected', reason: 'skill-gap' });
  assert.equal(first.recorded, true);
  assert.equal(again.recorded, false);
  assert.equal(ledger.outcomes().length, 1);
});

test('an outcome reason defaults to inferred, never explicit', () => {
  const app = ledger.add(base);
  const r = ledger.recordOutcome({ applicationId: app.id, outcome: 'rejected', reason: 'no-reason-given' });
  assert.equal(r.record.reasonBasis, 'inferred');
});

test('businessDaysBetween skips weekends', () => {
  // Mon 2026-08-03 -> Mon 2026-08-10 is 5 business days.
  assert.equal(ledger.businessDaysBetween('2026-08-03', '2026-08-10'), 5);
});

test('review counts unique submissions, duplicate rows and mature conversions', () => {
  const old = new Date(Date.now() - 60 * 86400000).toISOString();
  const a = ledger.add({ ...base, ts: old });
  ledger.add({ ...base, ts: old, url: 'https://boards.greenhouse.io/acme/jobs/456' });
  // A raw duplicate row (as found in the legacy CSV) must not inflate the count.
  require('../src/core/ndjson').append(require('../src/core/paths').applications(), ledger.normalize({ ...base, ts: old }));
  ledger.recordOutcome({ applicationId: a.id, outcome: 'interview' });

  const r = ledger.review();
  assert.equal(r.totals.uniqueSubmissions, 2);
  assert.equal(r.totals.duplicateRows, 1);
  assert.equal(r.totals.matureApplications, 2);
  assert.equal(r.conversions.positiveRate, 0.5);
  assert.equal(r.byDiscoverySource.linkedin.applications, 2);
});

test('generating a review does not acknowledge it; review-ack does', () => {
  ledger.add(base);
  assert.equal(ledger.review().due.newSinceAck.uniqueSubmissions, 1);
  ledger.review();
  assert.equal(ledger.review().due.newSinceAck.uniqueSubmissions, 1);
  ledger.reviewAck({ note: 'read it' });
  assert.equal(ledger.review().due.newSinceAck.uniqueSubmissions, 0);
});
