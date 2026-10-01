// Mid-run progress, written into the round record.
//
// THE PROBLEM
// A forty-minute run reported nothing until it ended. From the orchestrator's side that
// is indistinguishable from a hung run, and the only remedy was to wait — or to kill it
// and lose whatever it had done.
//
// Counts also could not be reconstructed afterwards. `applied` is derivable from the
// ledger (rows carrying the round id), but `skipped`, `errored` and `evaluated` lived
// only in local variables in src/index.js and went to seen-jobs.csv, which has no round
// id at all. So "what happened in last night's run" was a log grep, if the log still
// existed.
//
// Writing counts into the round record as jobs complete makes `round status` answerable
// mid-run by a separate process, without touching the running job.
//
// ── ON CONCURRENT WRITES ───────────────────────────────────────────────────
// rounds.json is read-modify-written whole. Two processes doing that at once would lose
// one of the updates. In practice they never do: the per-host semaphore allows one
// browser run per machine, and run-loop.js awaits each batch child before starting the
// next, so exactly one process is writing progress at any moment. The reader
// (`round status`) only reads. This is worth stating because it is a real constraint
// rather than an accident — a second concurrent writer would need a lock.
const fs = require('fs');

const paths = require('./paths');

// The anti-bot buckets. Kept separate from `errored` because a soft block is not a
// failure of ours: forty jobs skipped by DataDome is a blocked run, and reading it as
// "the job market is quiet" is the wrong conclusion entirely.
const BLOCKED_KINDS = ['captcha', 'datadome', 'turnstile', 'hcaptcha', 'recaptcha', 'cloudflare', 'other'];

const emptyBlocked = () => Object.fromEntries(BLOCKED_KINDS.map((k) => [k, 0]));

function emptyProgress() {
  return {
    evaluated: 0,
    applied: 0,
    skipped: 0,
    errored: 0,
    blocked: emptyBlocked(),
    batches: 0,
    lastJob: null,
    lastUpdateAt: null,
    startedAt: null,
  };
}

// Classify a handler's result reason into an anti-bot bucket, or null.
//
// Pattern-matching prose is not elegant, but the alternative is threading a structured
// code out of six handlers and util/captcha.js, and these strings are already the
// contract those handlers report through. The buckets are deliberately coarse: what
// matters is "was this a block?", not which vendor.
function classifyBlocked(reason) {
  const r = String(reason || '');
  if (!r) return null;
  if (/datadome|captcha-delivery/i.test(r)) return 'datadome';
  if (/turnstile/i.test(r)) return 'turnstile';
  if (/hcaptcha/i.test(r)) return 'hcaptcha';
  if (/recaptcha/i.test(r)) return 'recaptcha';
  if (/cloudflare/i.test(r)) return 'cloudflare';
  if (/captcha|anti-?bot|bot[- ]?flagged|challenge blocked/i.test(r)) return 'captcha';
  return null;
}

function load() {
  try { return JSON.parse(fs.readFileSync(paths.rounds(), 'utf8')); } catch { return { rounds: [] }; }
}
function save(db) {
  fs.writeFileSync(paths.rounds(), JSON.stringify(db, null, 2), { mode: 0o600 });
}

// Merge a delta into a round's progress. Returns the merged progress, or null when the
// round does not exist.
//
//   record(roundId, { evaluated: 1, applied: 1, lastJob: {...} })
//   record(roundId, { skipped: 1, blockedKind: 'datadome' })
//   record(roundId, { batches: 1 })
function record(roundId, delta = {}) {
  if (!roundId) return null;
  const db = load();
  const round = db.rounds.find((r) => r.id === roundId);
  if (!round) return null;

  const p = { ...emptyProgress(), ...(round.progress || {}) };
  p.blocked = { ...emptyBlocked(), ...(p.blocked || {}) };
  if (!p.startedAt) p.startedAt = new Date().toISOString();

  for (const key of ['evaluated', 'applied', 'skipped', 'errored', 'batches']) {
    if (delta[key]) p[key] = (p[key] || 0) + Number(delta[key]);
  }
  if (delta.blockedKind) {
    const k = BLOCKED_KINDS.includes(delta.blockedKind) ? delta.blockedKind : 'other';
    p.blocked[k] = (p.blocked[k] || 0) + 1;
  }
  if (delta.lastJob) {
    p.lastJob = {
      company: String(delta.lastJob.company || '').slice(0, 80),
      role: String(delta.lastJob.role || '').slice(0, 120),
      status: delta.lastJob.status || '',
      at: new Date().toISOString(),
    };
  }
  p.lastUpdateAt = new Date().toISOString();

  round.progress = p;
  save(db);
  return p;
}

// Convenience for the runner: one call per finished job.
function recordJob(roundId, { status, company, role, reason } = {}) {
  const delta = { evaluated: 1, lastJob: { company, role, status } };
  if (status === 'Applied') delta.applied = 1;
  else if (status === 'Skipped') delta.skipped = 1;
  else delta.errored = 1;
  const kind = classifyBlocked(reason);
  if (kind) delta.blockedKind = kind;
  return record(roundId, delta);
}

function get(roundId) {
  const round = load().rounds.find((r) => r.id === roundId);
  if (!round) return null;
  const p = { ...emptyProgress(), ...(round.progress || {}) };
  p.blocked = { ...emptyBlocked(), ...(p.blocked || {}) };
  return p;
}

// Total anti-bot encounters, for `blocked.total` in the digest.
const blockedTotal = (blocked) => Object.values(blocked || {}).reduce((n, v) => n + (Number(v) || 0), 0);

module.exports = { record, recordJob, get, classifyBlocked, emptyProgress, blockedTotal, BLOCKED_KINDS };
