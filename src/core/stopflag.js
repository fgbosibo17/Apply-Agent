// Cooperative stop: ask a running round to finish and wind down.
//
// WHY A FLAG FILE AND NOT A SIGNAL
// The process asking for the stop is usually on the other end of an SSH call and does
// not know the runner's pid — and even when it does, SIGTERM cuts the run off wherever
// it happens to be. That could be between filling a form and clicking submit, which is
// the one moment an application must not be interrupted: the form is filled, the
// employer has nothing, and the ledger has no row either way.
//
// So the runner polls this flag BETWEEN jobs, finishes the job in flight, and completes
// the round honestly with the counts it reached. A graceful stop is a shorter run, not
// a broken one.
//
// The flag is a file per round rather than a field in rounds.json, because the stopping
// process and the running process would otherwise read-modify-write the same JSON at
// the same time — and the point is to signal a live run without touching what it is
// writing.
const fs = require('fs');

const paths = require('./paths');
const machine = require('./machine');

// Ask a round to stop. Idempotent: asking twice is the same as asking once.
function request(roundId, { reason = '', force = false } = {}) {
  if (!roundId) throw new Error('stop: a round id is required');
  const existing = read(roundId);
  const record = {
    roundId,
    requestedAt: existing ? existing.requestedAt : new Date().toISOString(),
    requestedBy: machine.id(),
    reason: String(reason || '').slice(0, 200),
    force: !!force || (existing ? !!existing.force : false),
    // Bumped on a repeat request, so "I asked twice and nothing happened" is visible.
    requests: existing ? (existing.requests || 1) + 1 : 1,
  };
  fs.writeFileSync(paths.stopFlag(roundId), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

function read(roundId) {
  if (!roundId) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.stopFlag(roundId), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

const isRequested = (roundId) => !!read(roundId);

// Clear the flag. Called by the runner once it has acted on it, so a later round with a
// recycled id is not stopped by a stale request.
function clear(roundId) {
  try { fs.rmSync(paths.stopFlag(roundId), { force: true }); return true; } catch { return false; }
}

// Every outstanding request, for diagnostics.
function list() {
  let names = [];
  try { names = fs.readdirSync(paths.stopDir()); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.stop'))
    .map((n) => read(n.replace(/\.stop$/, '')))
    .filter(Boolean);
}

module.exports = { request, read, isRequested, clear, list };
