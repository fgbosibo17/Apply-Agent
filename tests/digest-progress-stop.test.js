// Digest, progress and stop.
//
// The three exist for one reason: a run on the server is a forty-minute black box to a
// process on another host. It reported nothing until it ended, could not be inspected
// while going, and could not be wound down without killing it and losing the record.
//
// The properties worth protecting:
//   PROGRESS  counts land in the round record per job, so `round status` is answerable
//             mid-run by a reader that touches nothing.
//   DIGEST    composes what already exists, so it cannot disagree with the state it
//             summarises; a soft block reads as a block, not as a quiet market; and the
//             age of the oldest attention item escalates instead of repeating quietly.
//   STOP      finishes the job in flight, completes the round honestly, and NEVER
//             leaves a lock held.
const assert = require('node:assert');
const { test, beforeEach } = require('node:test');
const fs = require('fs');
const { useTempState, resetState } = require('./helpers');

useTempState();

const rounds = require('../src/core/rounds');
const progress = require('../src/core/progress');
const digest = require('../src/core/digest');
const stopflag = require('../src/core/stopflag');
const queues = require('../src/core/queues');
const ledger = require('../src/core/ledger');
const locks = require('../src/core/locks');
const machine = require('../src/core/machine');
const paths = require('../src/core/paths');
const config = require('../src/core/config');

beforeEach(() => {
  resetState();
  machine.reset();
  config.reset();
});

const openRound = (over = {}) => rounds.start({ persona: 'secondary', target: 10, ...over }, { preflight: false, schema: false });
const ageAttention = (days) => {
  const f = paths.attention();
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const r of rows) if (r.status === 'open') r.ts = new Date(Date.now() - days * 86400000).toISOString();
  fs.writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
};

// ── progress ───────────────────────────────────────────────────────────────

test('progress accumulates per job into the round record', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme', role: 'SDET' });
  progress.recordJob(r.id, { status: 'Skipped', company: 'Globex' });
  progress.recordJob(r.id, { status: 'Error', company: 'Hooli' });

  const p = progress.get(r.id);
  assert.equal(p.evaluated, 3);
  assert.equal(p.applied, 1);
  assert.equal(p.skipped, 1);
  assert.equal(p.errored, 1);
  assert.equal(p.lastJob.company, 'Hooli');
  assert.ok(p.lastUpdateAt);
});

// The point of writing progress at all: a separate process can ask, mid-run, without
// touching the running job.
test('round status is answerable mid-run by a reader that only reads', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });

  const before = fs.statSync(paths.rounds()).mtimeMs;
  const st = rounds.status(r.id);
  assert.equal(st.running, true, 'the round is still open');
  assert.equal(st.progress.applied, 1);
  assert.equal(st.progress.evaluated, 1);
  assert.equal(fs.statSync(paths.rounds()).mtimeMs, before, 'reading must not write');
});

test('batches are counted separately from jobs', () => {
  const r = openRound();
  progress.record(r.id, { batches: 1 });
  progress.record(r.id, { batches: 1 });
  assert.equal(progress.get(r.id).batches, 2);
});

test('progress on an unknown round is a no-op rather than an error', () => {
  assert.equal(progress.record('rnd_nope', { applied: 1 }), null);
  assert.equal(progress.get('rnd_nope'), null);
});

// ── the blocked rollup ─────────────────────────────────────────────────────

// Forty jobs refused by DataDome and forty jobs that found nothing look identical in a
// bare skip count. They are not the same thing and must not read the same.
test('anti-bot reasons are classified into buckets', () => {
  const cases = {
    'SmartRecruiters DataDome (anti-bot) — skipped': 'datadome',
    'Blocked by Cloudflare Turnstile anti-bot (submission gated)': 'turnstile',
    'Blocked by hCaptcha challenge (needs manual solve)': 'hcaptcha',
    'invisible reCAPTCHA never returned a token': 'recaptcha',
    'interactive-captcha-skip': 'captcha',
    'No confirmation page after submit': null,
    'Non-US location: India': null,
  };
  for (const [reason, expected] of Object.entries(cases)) {
    assert.equal(progress.classifyBlocked(reason), expected, reason);
  }
});

test('a blocked job counts as blocked as well as skipped or errored', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Skipped', company: 'A', reason: 'SmartRecruiters DataDome (anti-bot)' });
  progress.recordJob(r.id, { status: 'Error', company: 'B', reason: 'Blocked by Cloudflare Turnstile anti-bot' });
  progress.recordJob(r.id, { status: 'Error', company: 'C', reason: 'No confirmation page after submit' });

  const d = digest.forRound(r.id);
  assert.equal(d.blocked.total, 2);
  assert.equal(d.blocked.byKind.datadome, 1);
  assert.equal(d.blocked.byKind.turnstile, 1);
  assert.equal(d.counts.errored, 2, 'still counted as errors too — this is a rollup, not a reclassification');
  assert.equal(d.blocked.shareOfEvaluated, 66.7);
  assert.match(d.blocked.note, /refused, not failed/);
});

test('a run with no blocks says so with a zero, not a missing field', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  const d = digest.forRound(r.id);
  assert.equal(d.blocked.total, 0);
  assert.equal(d.blocked.note, null);
});

// ── the digest ─────────────────────────────────────────────────────────────

test('the digest carries every documented field', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme', role: 'SDET' });
  ledger.add({ company: 'Acme', role: 'SDET', url: 'https://boards.greenhouse.io/acme/jobs/1', persona: 'secondary', roundId: r.id, confirmation: 'received' });

  const d = digest.forRound(r.id);
  assert.equal(d.round.id, r.id);
  assert.equal(d.round.persona, 'secondary');
  assert.equal(d.round.machineId, machine.id());
  assert.ok(d.round.startedAt);
  assert.equal(d.round.completedAt, null);
  assert.equal(typeof d.round.durationSec, 'number');
  for (const k of ['evaluated', 'applied', 'skipped', 'errored']) assert.ok(k in d.counts, k);
  assert.ok('state' in d.tailoring);
  assert.ok('open' in d.attention && 'attentionAgeDays' in d.attention);
  assert.ok('signatures' in d.friction);
  assert.ok('total' in d.blocked);
  assert.ok('diskFreeGb' in d.host && 'profileCount' in d.host);
  assert.equal(typeof d.needsAttention, 'boolean');
});

test('the ledger count is reported alongside progress, not instead of it', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  progress.recordJob(r.id, { status: 'Applied', company: 'Globex' });
  ledger.add({ url: 'https://boards.greenhouse.io/acme/jobs/1', roundId: r.id, confirmation: 'received' });

  const d = digest.forRound(r.id);
  assert.equal(d.counts.applied, 2, 'what the runner counted');
  assert.equal(d.counts.ledgerSubmissions, 1, 'what the ledger holds');
  // A disagreement is visible rather than hidden behind one number — that gap is a bug
  // worth seeing.
  assert.notEqual(d.counts.applied, d.counts.ledgerSubmissions);
});

test('attention items say which machine must resolve them', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'login-required', url: 'https://x/1', persona: 'secondary', roundId: r.id, summary: 'LinkedIn session expired' });
  const d = digest.forRound(r.id);
  assert.equal(d.attention.open, 1);
  const it = d.attention.items[0];
  assert.equal(it.kind, 'login-required');
  assert.equal(it.machineId, machine.id(), 'a login lives in this machine profile; profiles never travel');
  assert.ok(it.summary.length > 0);
  assert.equal(d.needsAttention, true);
});

test('an attention item from an older commit reports its machine as unknown, not as ours', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'captcha', url: 'https://x/1', roundId: r.id, summary: 'needs a human' });
  // Strip the field, as a pre-v3 row would be.
  const f = paths.attention();
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  delete rows[0].machineId;
  fs.writeFileSync(f, rows.map((x) => JSON.stringify(x)).join('\n') + '\n');

  assert.equal(digest.forRound(r.id).attention.items[0].machineId, 'unknown');
});

// A login that expired two nights ago means every run since burned its queue against a
// dead session. The age is what turns that from a repeated note into an escalation.
test('attentionAgeDays is the age of the OLDEST unresolved item and escalates', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'login-required', url: 'https://x/1', roundId: r.id, summary: 'expired login' });
  ageAttention(3);
  queues.attentionAdd({ kind: 'captcha', url: 'https://x/2', roundId: r.id, summary: 'fresh one' });

  const d = digest.forRound(r.id);
  assert.equal(d.attention.open, 2);
  assert.equal(d.attention.attentionAgeDays, 3, 'oldest, not newest, not average');
  assert.equal(d.attention.escalate, true);
});

test('a fresh attention item does not escalate', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'captcha', url: 'https://x/1', roundId: r.id, summary: 'just now' });
  const d = digest.forRound(r.id);
  assert.equal(d.attention.attentionAgeDays, 0);
  assert.equal(d.attention.escalate, false);
});

test('no open items means nothing needs attention', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  const d = digest.forRound(r.id);
  assert.equal(d.attention.open, 0);
  assert.equal(d.attention.attentionAgeDays, null);
  assert.equal(d.needsAttention, false);
});

test('friction signatures come through with counts', () => {
  const r = openRound();
  for (let i = 0; i < 3; i++) {
    queues.frictionRecord({ area: 'ats:greenhouse', url: `https://x/${i}`, summary: 'application failed', signature: 'No confirmation page after submit' });
  }
  const d = digest.forRound(r.id);
  assert.equal(d.friction.signatures, 1);
  assert.equal(d.friction.total, 3);
  assert.equal(d.friction.top[0].count, 3);
  assert.match(d.friction.top[0].signature, /No confirmation/);
});

test('an unknown round yields null rather than an empty digest', () => {
  assert.equal(digest.forRound('rnd_nope'), null);
});

// ── telegram ───────────────────────────────────────────────────────────────

test('telegram output stays under 400 characters', () => {
  const r = openRound();
  for (let i = 0; i < 9; i++) {
    queues.attentionAdd({
      kind: 'captcha', url: `https://x/${i}`, roundId: r.id,
      summary: 'Interactive hCaptcha challenge needs a human on this machine and this summary is deliberately long to push the limit',
    });
  }
  for (let i = 0; i < 20; i++) progress.recordJob(r.id, { status: 'Error', company: `C${i}`, reason: 'DataDome anti-bot' });

  const text = digest.telegram(digest.forRound(r.id));
  assert.ok(text.length <= digest.LIMIT, `expected <= ${digest.LIMIT}, got ${text.length}`);
});

// The ordering is the design: counts are interesting, attention is the only part a human
// must act on, so it cannot be what falls off the end of a truncated message.
test('telegram LEADS with attention and never truncates it away', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'login-required', url: 'https://x/1', roundId: r.id, summary: 'LinkedIn session expired' });
  for (let i = 0; i < 40; i++) progress.recordJob(r.id, { status: 'Error', company: `Company${i}`, reason: 'Blocked by Cloudflare Turnstile anti-bot' });

  const text = digest.telegram(digest.forRound(r.id));
  const lines = text.split('\n');
  assert.match(lines[0], /needs? you/, 'the first line is the attention headline');
  assert.match(text, /login-required/);
  assert.ok(text.length <= digest.LIMIT);
});

test('telegram says so plainly when nothing needs a human', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  const text = digest.telegram(digest.forRound(r.id));
  assert.match(text.split('\n')[0], /nothing needs you/);
  assert.match(text, /1 applied/);
});

test('telegram escalates an aged item and explains the cost', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'login-required', url: 'https://x/1', roundId: r.id, summary: 'expired login' });
  ageAttention(4);
  const text = digest.telegram(digest.forRound(r.id));
  assert.match(text, /‼️/);
  assert.match(text, /oldest 4d/);
  assert.match(text, /burned queue/);
});

test('telegram marks a blocked run as blocked rather than as a quiet market', () => {
  const r = openRound();
  for (let i = 0; i < 5; i++) progress.recordJob(r.id, { status: 'Skipped', company: `C${i}`, reason: 'SmartRecruiters DataDome (anti-bot)' });
  const text = digest.telegram(digest.forRound(r.id));
  assert.match(text, /blocked/);
  assert.match(text, /anti-bot, not a quiet market/);
});

// ── --since ────────────────────────────────────────────────────────────────

test('--since aggregates several rounds', () => {
  const a = openRound();
  progress.recordJob(a.id, { status: 'Applied', company: 'A' });
  rounds.complete({ id: a.id });
  const b = openRound();
  progress.recordJob(b.id, { status: 'Applied', company: 'B' });
  progress.recordJob(b.id, { status: 'Skipped', company: 'C', reason: 'DataDome anti-bot' });

  const d = digest.since(7);
  assert.equal(d.rounds.count, 2);
  assert.equal(d.counts.applied, 2);
  assert.equal(d.counts.skipped, 1);
  assert.equal(d.counts.evaluated, 3);
  assert.equal(d.blocked.total, 1);
  assert.equal(d.rounds.perRound.length, 2);
});

test('--since excludes rounds outside the window', () => {
  const old = openRound();
  rounds.complete({ id: old.id });
  // Age it well past the window.
  const db = JSON.parse(fs.readFileSync(paths.rounds(), 'utf8'));
  db.rounds[0].startedAt = new Date(Date.now() - 30 * 86400000).toISOString();
  fs.writeFileSync(paths.rounds(), JSON.stringify(db, null, 2));

  assert.equal(digest.since(7).rounds.count, 0);
  assert.equal(digest.since(60).rounds.count, 1);
});

// An item raised nine days ago is exactly what a weekly summary must surface, even if
// its round is outside the window.
test('--since keeps every open attention item, not just the window\'s', () => {
  const r = openRound();
  queues.attentionAdd({ kind: 'login-required', url: 'https://x/1', roundId: r.id, summary: 'expired' });
  ageAttention(9);
  const d = digest.since(1);
  assert.equal(d.attention.open, 1);
  assert.equal(d.attention.attentionAgeDays, 9);
  assert.equal(d.attention.escalate, true);
  assert.equal(d.needsAttention, true);
});

// ── stop ───────────────────────────────────────────────────────────────────

test('a stop request is visible to the runner and idempotent', () => {
  const r = openRound();
  assert.equal(stopflag.isRequested(r.id), false);
  const first = stopflag.request(r.id, { reason: 'orchestrator asked' });
  assert.equal(stopflag.isRequested(r.id), true);
  assert.equal(rounds.status(r.id).stopRequested, true);
  assert.equal(first.requests, 1);

  const second = stopflag.request(r.id, { reason: 'again' });
  assert.equal(second.requests, 2, 'a repeat is countable');
  assert.equal(second.requestedAt, first.requestedAt, 'the original time is kept');
});

test('the stop flag file is owner-only', () => {
  const r = openRound();
  stopflag.request(r.id);
  assert.equal(fs.statSync(paths.stopFlag(r.id)).mode & 0o777, 0o600);
});

test('completing a stopped round records that it stopped, with the counts it reached', () => {
  const r = openRound();
  progress.recordJob(r.id, { status: 'Applied', company: 'Acme' });
  progress.recordJob(r.id, { status: 'Skipped', company: 'Globex' });
  stopflag.request(r.id, { reason: 'orchestrator asked' });

  rounds.complete({ id: r.id, note: 'stopped after 2 evaluated', stopped: { reason: 'orchestrator asked', requestedBy: 'runner-x' } });

  const d = digest.forRound(r.id);
  assert.ok(d.round.stopped, 'the digest is marked stopped');
  assert.equal(d.round.stopped.reason, 'orchestrator asked');
  assert.equal(d.round.running, false);
  assert.equal(d.counts.applied, 1, 'honest counts, not zeroed');
  assert.equal(d.counts.evaluated, 2);
});

// The rule with no exceptions: a stopped run must never leave a lock held. An open lock
// blocks the next scheduled run until the staleness threshold expires.
test('a stopped round releases both guards', () => {
  const r = rounds.start({ persona: 'secondary', target: 5 }, { preflight: false, schema: false });
  assert.ok(locks.inspectProfile('secondary'), 'held while running');

  stopflag.request(r.id, { reason: 'stop' });
  rounds.complete({ id: r.id, stopped: { reason: 'stop' } });

  assert.equal(locks.inspectProfile('secondary'), null, 'profile lock released');
  assert.equal(locks.inspectHost(), null, 'semaphore released');
  assert.deepEqual(locks.list(), []);
});

test('completing clears the stop flag so a later round cannot inherit it', () => {
  const r = openRound();
  stopflag.request(r.id);
  rounds.complete({ id: r.id, stopped: { reason: 'stop' } });
  assert.equal(stopflag.isRequested(r.id), false);
});

test('a stopped round does not block the next one', () => {
  const first = rounds.start({ persona: 'secondary' }, { preflight: false, schema: false });
  stopflag.request(first.id);
  rounds.complete({ id: first.id, stopped: { reason: 'stop' } });

  const second = rounds.start({ persona: 'adjacent' }, { preflight: false, schema: false });
  assert.ok(second.id, 'the next run gets straight in');
});

test('stopflag.list reports outstanding requests', () => {
  const a = openRound();
  stopflag.request(a.id, { reason: 'one' });
  const all = stopflag.list();
  assert.equal(all.length, 1);
  assert.equal(all[0].roundId, a.id);
  assert.equal(all[0].reason, 'one');
});
