// Resumable rounds.
//
// run-loop.js already batches with a fresh browser; a round ID makes those
// batches addressable after the fact — every ledger row, attention item and
// friction record carries the round it came from, so "what happened in the
// 200-job overnight run" is one query instead of a log grep.
const crypto = require('crypto');
const fs = require('fs');
const paths = require('./paths');
const ledger = require('./ledger');
const { attentionList } = require('./queues');
const preflight = require('./preflight');
const locks = require('./locks');
const machine = require('./machine');
const { profileKeyFor } = require('../personas');

function load() {
  try { return JSON.parse(fs.readFileSync(paths.rounds(), 'utf8')); } catch { return { rounds: [] }; }
}
function save(db) {
  fs.writeFileSync(paths.rounds(), JSON.stringify(db, null, 2), { mode: 0o600 });
}

// Start a round — but only if this machine can actually run it.
//
// WHY HERE
// Failures used to surface mid-run: a missing resume discovered per job by a
// `.catch(() => {})` that discarded it, a browser profile nobody had logged into, no
// xvfb-run on a box with no display. Checking at round start makes that one loud
// refusal before any browser opens, instead of N silent empty applications or a
// half-consumed queue.
//
// The blocking subset only. Warnings (no secret-tool, mtime-stale node_modules) are
// doctor's business, not a reason to refuse work.
//
// Resumes are checked for EVERY persona, not just this round's: the cost is three
// stat calls, and the failure it catches — a resume renamed or re-exported on the
// laptop — is otherwise invisible until the persona that owns it next runs, which on
// the scheduled server is the middle of the night. Browser profiles are narrowed to
// this round's persona, because a profile is per-machine by design and an absent
// fullstack profile is no reason to refuse a qa round.
//
// `opts` is deliberately a SECOND argument. `round start --stdin` parses stdin JSON
// into `input`, so a caller (including the remote orchestrator) cannot disable the
// preflight by passing `{"preflight": false}`. Only in-process callers can, and the
// only ones that do are tests.
function start(input = {}, opts = {}) {
  // Schema gate FIRST, before preflight and before any guard is taken.
  //
  // A round reads the ledger (dedup, progress) and writes rows back to it. If this
  // repo is older than the state another machine wrote, every row it rewrites loses the
  // fields it does not know about — silently, in the one file whose accuracy is the
  // point. Refuse before touching anything. Newer code reading older state migrates
  // forward here instead, which is the normal upgrade and needs no flag.
  if (opts.schema !== false) require('./schema').assertCompatible();

  if (opts.preflight !== false) {
    const io = { ...(opts.io || {}) };
    if (opts.personas) io.personas = opts.personas;
    // Throws PreflightError; src/cli.js renders it as JSON with a remedy per failure.
    preflight.assertReady({ profilePersona: input.persona || undefined, io });
  }

  // Take both run guards BEFORE recording the round. A round that could not run
  // should not exist: it would show up in `round list` as perpetually open and
  // muddle every "what happened last night" query.
  //
  // Guards are keyed on the PROFILE, so a fullstack round is refused while cloud is
  // running (one identity, one browser account) while qa is unaffected. Throws
  // locks.GuardRefusedError, which names which guard refused — the caller's
  // response to "another machine holds this profile" is not the same as to "this
  // host is already running a browser session".
  const profileKey = input.profileKey || profileKeyFor(input.persona) || input.persona || '';
  let held = null;
  if (opts.guards !== false && profileKey) {
    held = locks.acquireAll({ profileKey, roundId: '', persona: input.persona || '' });
  }

  try {
    const db = load();
    const round = {
      id: input.id || 'rnd_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + crypto.randomBytes(4).toString('hex'),
      startedAt: new Date().toISOString(),
      completedAt: null,
      persona: input.persona || '',
      profileKey,
      // Which machine opened this round. The lock names its holder; this survives
      // after the lock is released.
      machineId: machine.id(),
      hostname: machine.hostname(),
      target: Number(input.target) || 0,
      maxEvaluated: Number(input.maxEvaluated) || 0,
      autonomyMode: input.autonomyMode || '',
      note: (input.note || '').slice(0, 200),
    };
    db.rounds.push(round);
    save(db);
    // Stamp the round id into the guards now that it exists, so a later refusal can
    // name the round that is holding them.
    if (held) stampRound(profileKey, round.id);
    return round;
  } catch (e) {
    // Never leave a guard held for a round that failed to record.
    if (held) locks.releaseAll({ profileKey, force: true });
    throw e;
  }
}

// Write the round id into both guard files. Separate from acquire because the round
// id does not exist until the record is written.
function stampRound(profileKey, roundId) {
  for (const file of [locks.profileLockPath(profileKey), locks.semaphorePath()]) {
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (rec.machineId !== machine.id()) continue;
      rec.roundId = roundId;
      rec.heartbeatAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(rec, null, 2), { mode: 0o600 });
    } catch { /* the guard may be disabled; nothing to stamp */ }
  }
  return true;
}

function status(roundId) {
  const db = load();
  const round = roundId
    ? db.rounds.find((r) => r.id === roundId)
    : db.rounds.filter((r) => !r.completedAt).slice(-1)[0] || db.rounds.slice(-1)[0];
  if (!round) return null;
  const apps = ledger.applications().filter((a) => a.roundId === round.id && a.status === 'submitted');
  const attention = attentionList().filter((a) => a.roundId === round.id);
  return {
    ...round,
    submitted: apps.length,
    remaining: round.target ? Math.max(0, round.target - apps.length) : null,
    attentionOpen: attention.length,
    companies: [...new Set(apps.map((a) => a.company))].slice(0, 50),
    // `round.progress` is already spread in above by ...round. It is written per job by
    // src/core/progress.js, which is what makes this answerable MID-RUN from another
    // process: this function only reads.
    running: !round.completedAt,
    stopRequested: require('./stopflag').isRequested(round.id),
  };
}

// Close a round and release both guards.
//
// Release is unconditional-ish on purpose: it runs even if the round record cannot be
// found or written, because a held guard blocks the NEXT run and a leaked one is
// worse than a missing outcome note. locks.releaseAll only removes locks this machine
// holds for this round, so it cannot stomp the other machine's healthy run.
function complete(input = {}) {
  const db = load();
  const round = db.rounds.find((r) => r.id === input.id) || db.rounds.filter((r) => !r.completedAt).slice(-1)[0];
  if (!round) {
    // No record to close, but a guard may still be held under this id. Free it.
    if (input.id || input.profileKey) {
      release({ roundId: input.id, profileKey: input.profileKey });
    }
    throw new Error('round complete: no open round');
  }
  try {
    round.completedAt = new Date().toISOString();
    round.outcomeNote = (input.note || '').slice(0, 300);
    // A round that was asked to stop records that it stopped, with the counts it
    // actually reached. An honest short run is a different thing from one that fell
    // over, and a digest that cannot tell them apart is misleading.
    if (input.stopped) {
      round.stopped = {
        at: round.completedAt,
        reason: String(input.stopped.reason || input.stopped || '').slice(0, 200),
        requestedBy: input.stopped.requestedBy || null,
        force: !!input.stopped.force,
      };
    }
    save(db);
    return status(round.id);
  } finally {
    release({ roundId: round.id, profileKey: round.profileKey || profileKeyFor(round.persona) });
    // The stop request has been honoured; clear it so a later round cannot inherit it.
    try { require('./stopflag').clear(round.id); } catch { /* best effort */ }
  }
}

// Release both guards for a round. Every abort path calls this — a crashed run that
// keeps its lock costs the next scheduled run, which on the server is a whole night.
function release({ roundId, profileKey, persona } = {}) {
  const key = profileKey || profileKeyFor(persona) || (roundId ? (load().rounds.find((r) => r.id === roundId) || {}).profileKey : '') || '';
  return locks.releaseAll({ profileKey: key, roundId });
}

// Refresh both guards for a long-running round.
function heartbeat({ roundId, profileKey, persona } = {}) {
  const key = profileKey || profileKeyFor(persona)
    || (roundId ? (load().rounds.find((r) => r.id === roundId) || {}).profileKey : '') || '';
  return locks.heartbeat({ profileKey: key, roundId });
}

// Take over the guards for a round in THIS process (see locks.adopt).
function adopt({ roundId, profileKey, persona } = {}) {
  const key = profileKey || profileKeyFor(persona)
    || (roundId ? (load().rounds.find((r) => r.id === roundId) || {}).profileKey : '') || '';
  return locks.adopt({ profileKey: key, roundId });
}

function list() { return load().rounds; }

module.exports = { start, status, complete, list, release, heartbeat, adopt };
