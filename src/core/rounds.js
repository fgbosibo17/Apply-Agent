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

function load() {
  try { return JSON.parse(fs.readFileSync(paths.rounds(), 'utf8')); } catch { return { rounds: [] }; }
}
function save(db) {
  fs.writeFileSync(paths.rounds(), JSON.stringify(db, null, 2), { mode: 0o600 });
}

function start(input = {}) {
  const db = load();
  const round = {
    id: input.id || 'rnd_' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + crypto.randomBytes(4).toString('hex'),
    startedAt: new Date().toISOString(),
    completedAt: null,
    persona: input.persona || '',
    target: Number(input.target) || 0,
    maxEvaluated: Number(input.maxEvaluated) || 0,
    autonomyMode: input.autonomyMode || '',
    note: (input.note || '').slice(0, 200),
  };
  db.rounds.push(round);
  save(db);
  return round;
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
  };
}

function complete(input = {}) {
  const db = load();
  const round = db.rounds.find((r) => r.id === input.id) || db.rounds.filter((r) => !r.completedAt).slice(-1)[0];
  if (!round) throw new Error('round complete: no open round');
  round.completedAt = new Date().toISOString();
  round.outcomeNote = (input.note || '').slice(0, 300);
  save(db);
  return status(round.id);
}

function list() { return load().rounds; }

module.exports = { start, status, complete, list };
