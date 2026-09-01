const { test } = require('node:test');
const assert = require('node:assert');
const { canonicalizeUrl, employerJobId, provider, companyKey, roleKey } = require('../src/core/canonical');

test('canonicalizeUrl strips tracking params, hash, www and the /application suffix', () => {
  assert.equal(
    canonicalizeUrl('http://www.boards.greenhouse.io/acme/jobs/123/application?utm_source=li&gh_src=abc#top'),
    'https://boards.greenhouse.io/acme/jobs/123');
});

test('canonicalizeUrl collapses greenhouse host aliases', () => {
  assert.equal(canonicalizeUrl('https://job-boards.greenhouse.io/acme/jobs/123'),
               canonicalizeUrl('https://boards.greenhouse.io/acme/jobs/123'));
});

test('canonicalizeUrl keeps meaningful query params', () => {
  assert.match(canonicalizeUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=99'), /token=99/);
});

test('employerJobId is stable across hosts and suffixes for one requisition', () => {
  const a = employerJobId('https://boards.greenhouse.io/acme/jobs/123');
  const b = employerJobId('https://job-boards.greenhouse.io/acme/jobs/123/application?utm_medium=x');
  assert.equal(a, 'greenhouse:acme:123');
  assert.equal(a, b);
});

test('employerJobId handles lever, ashby, workable and smartrecruiters', () => {
  assert.equal(employerJobId('https://jobs.lever.co/foodsmart/7cd3c3d5-9afb-4c98-b4c6-c0a7bdb6504e'),
               'lever:foodsmart:7cd3c3d5-9afb-4c98-b4c6-c0a7bdb6504e');
  assert.equal(employerJobId('https://jobs.ashbyhq.com/assured/e9827d71-0d70-4eb8-b164-3d73a7ea7668'),
               'ashby:assured:e9827d71-0d70-4eb8-b164-3d73a7ea7668');
  assert.equal(employerJobId('https://apply.workable.com/acme/j/ABC123/'), 'workable:acme:ABC123');
  assert.equal(employerJobId('https://jobs.smartrecruiters.com/Acme/744000-sdet'), 'smartrecruiters:acme:744000');
});

test('employerJobId returns empty rather than guessing for unknown hosts', () => {
  assert.equal(employerJobId('https://careers.example.com/roles/sdet'), '');
});

test('provider identifies the application channel', () => {
  assert.equal(provider('https://boards.greenhouse.io/x/jobs/1'), 'greenhouse');
  assert.equal(provider('https://careers.example.com/x'), 'company');
  assert.equal(provider('not a url'), 'unknown');
});

test('companyKey collapses legal suffixes and punctuation', () => {
  assert.equal(companyKey('Stripe, Inc.'), companyKey('Stripe'));
  assert.equal(companyKey('Acme Technologies LLC'), companyKey('Acme'));
  assert.notEqual(companyKey('Acme'), companyKey('Acme Health'));
});

test('roleKey collapses abbreviations but keeps seniority distinct', () => {
  assert.equal(roleKey('Sr. SDET (Remote)'), roleKey('Senior SDET'));
  assert.notEqual(roleKey('Senior SDET'), roleKey('Staff SDET'));
});
