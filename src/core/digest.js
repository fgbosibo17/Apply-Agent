// The digest: one JSON object describing a round, for a process on another host.
//
// An orchestrator reporting to chat needs structure, not log prose. Everything here is
// COMPOSED from what the run already recorded — round status, progress counts, the
// attention and friction queues, the ledger, the host — so the digest cannot disagree
// with the state it summarises. Nothing is computed twice and nothing is stored twice.
//
// `ledger review` is deliberately untouched and NOT used here. It counts only
// applications old enough to have plausibly heard back, which is the right measure for
// "is this working?" and the wrong one for "what happened last night".
const paths = require('./paths');
const rounds = require('./rounds');
const progressStore = require('./progress');
const queues = require('./queues');
const ledger = require('./ledger');
const machine = require('./machine');
const stopflag = require('./stopflag');
const config = require('./config');

const DAY_MS = 86400000;

const ageDays = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / DAY_MS);
};
const round1 = (n) => Math.round(n * 10) / 10;

// How long an unresolved attention item may sit before it is an escalation rather than
// a note. One day: an expired login discovered on Monday means Tuesday's run burned its
// queue against a dead session, and Wednesday's will too.
const ESCALATE_AFTER_DAYS = Number(process.env.APPLY_AGENT_ATTENTION_ESCALATE_DAYS || 1);

function hostBlock() {
  const disk = require('../util/disk');
  let free = null;
  try { free = disk.freeGb(paths.root); } catch { free = null; }
  let profiles = { knownCount: null, unknownCount: null, liveMb: null };
  try {
    const t = require('./profiles').list({ measureSizes: true }).totals;
    profiles = { knownCount: t.knownCount, unknownCount: t.unknownCount, liveMb: t.liveMb };
  } catch { /* reported as nulls */ }
  return {
    machineId: machine.id(),
    hostname: machine.hostname(),
    diskFreeGb: free === null ? null : round1(free),
    diskFloorGb: Number(config().diskFreeFloorGb),
    profileCount: profiles.knownCount,
    orphanProfileCount: profiles.unknownCount,
    profilesMb: profiles.liveMb,
  };
}

// Attention items for a round (or all open ones), each answering: what kind, one line of
// what it is, and WHICH MACHINE has to fix it.
function attentionBlock(roundId, { allOpen = false } = {}) {
  const open = queues.attentionList().filter((a) => allOpen || !roundId || a.roundId === roundId);
  const items = open.map((a) => ({
    id: a.id,
    kind: a.kind,
    severity: a.severity,
    summary: (a.summary || '').replace(/\s+/g, ' ').slice(0, 140),
    // Older rows predate the machineId field; say unknown rather than guessing.
    machineId: a.machineId || 'unknown',
    persona: a.persona || '',
    company: a.company || '',
    url: a.url || '',
    ageDays: ageDays(a.ts),
    raisedAt: a.ts,
  }));
  const ages = items.map((i) => i.ageDays).filter((d) => d !== null);
  const oldest = ages.length ? Math.max(...ages) : null;
  return {
    open: items.length,
    // The age of the OLDEST unresolved item. This is the number that turns a repeated
    // quiet failure into an escalation.
    attentionAgeDays: oldest,
    escalate: oldest !== null && oldest >= ESCALATE_AFTER_DAYS,
    escalateAfterDays: ESCALATE_AFTER_DAYS,
    items,
  };
}

// Failure signatures with counts, most frequent first. frictionList already aggregates.
function frictionBlock({ limit = 10 } = {}) {
  let rows = [];
  try { rows = queues.frictionList(); } catch { rows = []; }
  return {
    signatures: rows.length,
    total: rows.reduce((n, r) => n + (r.count || 0), 0),
    top: rows.slice(0, limit).map((r) => ({
      area: r.area,
      signature: (r.signature || r.summary || '').slice(0, 120),
      count: r.count,
      lastSeen: r.lastSeen,
    })),
  };
}

// Anti-bot rollup. A soft block must read as a soft block: forty jobs skipped by
// DataDome is not a quiet job market, and the two look identical in a bare skip count.
function blockedBlock(prog, roundId) {
  const blocked = prog.blocked || {};
  const total = progressStore.blockedTotal(blocked);
  // Discovery producing nothing is the other half of the same story: a queue that never
  // filled looks like "no jobs" whether the boards were empty or were refusing us.
  let emptyDiscovery = 0;
  try {
    emptyDiscovery = queues.frictionList()
      .filter((f) => /discover|no results|fetched 0|empty/i.test(`${f.area} ${f.signature} ${f.summary}`))
      .reduce((n, f) => n + (f.count || 0), 0);
  } catch { emptyDiscovery = 0; }

  return {
    total,
    byKind: blocked,
    emptyDiscoveryResults: emptyDiscovery,
    // A run where most evaluated jobs hit a block is a blocked run, not a poor queue.
    shareOfEvaluated: prog.evaluated ? round1((total / prog.evaluated) * 100) : 0,
    note: total
      ? 'Anti-bot encounters are counted separately from errors: these jobs were refused, not failed.'
      : null,
  };
}

// Tailoring, read from the manifest rather than re-derived.
function tailoringBlock(roundId) {
  let rows = [];
  try { rows = require('../resume/manifest').all().filter((r) => !roundId || r.roundId === roundId); } catch { rows = []; }
  if (!rows.length) return { state: 'off', accepted: 0, rejected: 0, fallback: 0 };
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    state: 'on',
    accepted: count('accepted'),
    rejected: count('rejected'),
    fallback: count('fallback'),
    backends: [...new Set(rows.map((r) => r.backend).filter(Boolean))],
  };
}

// ── one round ──────────────────────────────────────────────────────────────

function forRound(roundId) {
  const st = rounds.status(roundId);
  if (!st) return null;

  const prog = progressStore.get(st.id) || progressStore.emptyProgress();
  const stop = stopflag.read(st.id);
  const end = st.completedAt || null;
  const startMs = Date.parse(st.startedAt || '') || null;
  const endMs = end ? Date.parse(end) : Date.now();
  const durationSec = startMs ? Math.max(0, Math.round((endMs - startMs) / 1000)) : null;

  const attention = attentionBlock(st.id);
  const ledgerRows = ledger.applications().filter((a) => a.roundId === st.id);

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    round: {
      id: st.id,
      persona: st.persona || '',
      profileKey: st.profileKey || '',
      machineId: st.machineId || 'unknown',
      hostname: st.hostname || '',
      startedAt: st.startedAt || null,
      completedAt: end,
      durationSec,
      running: !end,
      target: st.target || 0,
      // A round asked to stop, or that stopped, says so — an honest short run reads very
      // differently from one that fell over.
      stopped: st.stopped || (stop ? { requested: true, requestedAt: stop.requestedAt, by: stop.requestedBy, reason: stop.reason } : null),
    },
    counts: {
      // From progress (written per job during the run) rather than recomputed, so a
      // mid-run digest and a final one are the same shape.
      evaluated: prog.evaluated,
      applied: prog.applied,
      skipped: prog.skipped,
      errored: prog.errored,
      dryRun: prog.dryRun || 0,
      batches: prog.batches,
      // The ledger is the authority on submissions; a disagreement with progress.applied
      // is itself worth seeing rather than hiding behind one number.
      ledgerSubmissions: ledgerRows.length,
      remaining: st.remaining,
      lastJob: prog.lastJob,
      lastUpdateAt: prog.lastUpdateAt,
    },
    tailoring: tailoringBlock(st.id),
    attention,
    friction: frictionBlock(),
    blocked: blockedBlock(prog, st.id),
    host: hostBlock(),
    companies: st.companies || [],
    needsAttention: attention.open > 0,
  };
}

// ── several rounds ─────────────────────────────────────────────────────────

// `--since 7d`: a weekly summary. Aggregates counts across rounds and keeps the
// attention list whole, because attention items are the part a human must act on and
// summing them away would defeat the purpose.
function since(days, { persona = null } = {}) {
  const cutoff = Date.now() - Number(days) * DAY_MS;
  const all = rounds.list().filter((r) => {
    const t = Date.parse(r.startedAt || '');
    return !Number.isNaN(t) && t >= cutoff && (!persona || r.persona === persona);
  });

  const zero = { evaluated: 0, applied: 0, skipped: 0, errored: 0, dryRun: 0, batches: 0, ledgerSubmissions: 0 };
  const counts = { ...zero };
  const blocked = {};
  const tail = { accepted: 0, rejected: 0, fallback: 0 };
  const perRound = [];

  const ledgerAll = ledger.applications();
  for (const r of all) {
    const prog = progressStore.get(r.id) || progressStore.emptyProgress();
    for (const k of Object.keys(zero)) if (k !== 'ledgerSubmissions') counts[k] += prog[k] || 0;
    const rows = ledgerAll.filter((a) => a.roundId === r.id).length;
    counts.ledgerSubmissions += rows;
    for (const [k, v] of Object.entries(prog.blocked || {})) blocked[k] = (blocked[k] || 0) + v;
    const t = tailoringBlock(r.id);
    tail.accepted += t.accepted; tail.rejected += t.rejected; tail.fallback += t.fallback;
    perRound.push({
      id: r.id, persona: r.persona, machineId: r.machineId || 'unknown',
      startedAt: r.startedAt, completedAt: r.completedAt,
      applied: prog.applied, evaluated: prog.evaluated, ledgerSubmissions: rows,
      stopped: !!r.stopped,
    });
  }

  // Open items across everything, not just these rounds: an item raised nine days ago is
  // exactly the one a weekly summary must surface.
  const attention = attentionBlock(null, { allOpen: true });

  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    window: { days: Number(days), since: new Date(cutoff).toISOString(), persona: persona || null },
    rounds: { count: all.length, ids: all.map((r) => r.id), perRound },
    counts,
    tailoring: all.length ? { state: tail.accepted + tail.rejected + tail.fallback ? 'on' : 'off', ...tail } : { state: 'off', ...tail },
    attention,
    friction: frictionBlock(),
    blocked: {
      total: progressStore.blockedTotal(blocked),
      byKind: blocked,
      shareOfEvaluated: counts.evaluated ? round1((progressStore.blockedTotal(blocked) / counts.evaluated) * 100) : 0,
    },
    host: hostBlock(),
    needsAttention: attention.open > 0,
  };
}

// ── telegram ───────────────────────────────────────────────────────────────

// Plain text under 400 characters, ATTENTION FIRST.
//
// The ordering is the whole design. Counts are interesting; attention items are the only
// part a human must actually do something about, and in a message that may be truncated
// they cannot be the thing that falls off the end.
const LIMIT = 400;

function telegram(d) {
  const lines = [];
  const isWindow = !!d.window;

  // 1. Attention, loudest first.
  const a = d.attention || { open: 0, items: [] };
  if (a.open) {
    const age = a.attentionAgeDays;
    lines.push(`${a.escalate ? '‼️' : '⚠️'} ${a.open} need${a.open === 1 ? 's' : ''} you`
      + (age !== null ? ` (oldest ${age}d)` : ''));
    // Two items at most: enough to act on, short enough to survive the limit.
    for (const it of a.items.slice(0, 2)) {
      lines.push(`• ${it.kind} @${it.machineId.split('-')[0]}: ${it.summary.slice(0, 70)}`);
    }
    if (a.open > 2) lines.push(`• +${a.open - 2} more`);
    if (a.escalate) lines.push('Every run since has burned queue — fix before the next.');
  } else {
    lines.push('✅ nothing needs you');
  }

  // 2. Then the counts.
  const c = d.counts || {};
  const head = isWindow
    ? `${d.window.days}d: ${d.rounds.count} round(s)`
    : `${d.round.persona || 'run'} ${d.round.id.slice(-8)}${d.round.running ? ' (running)' : ''}`;
  lines.push(`${head} — ${c.applied || 0} applied, ${c.skipped || 0} skipped, ${c.errored || 0} err`
    + `${c.dryRun ? `, ${c.dryRun} dry-run` : ''} of ${c.evaluated || 0}`);

  if (!isWindow && d.round.stopped) lines.push('⏹ stopped early');

  const b = d.blocked || {};
  if (b.total) lines.push(`🚧 ${b.total} blocked (${b.shareOfEvaluated}%) — anti-bot, not a quiet market`);

  const t = d.tailoring || {};
  if (t.state === 'on') lines.push(`✂️ tailored ${t.accepted}, base ${t.rejected + t.fallback}`);

  const h = d.host || {};
  if (h.diskFreeGb !== null && h.diskFloorGb && h.diskFreeGb < h.diskFloorGb * 3) {
    lines.push(`💾 ${h.diskFreeGb}GB free (floor ${h.diskFloorGb})`);
  }

  // Trim from the END, never the start: attention survives.
  let text = lines.join('\n');
  while (text.length > LIMIT && lines.length > 1) {
    lines.pop();
    text = lines.join('\n');
  }
  return text.length > LIMIT ? text.slice(0, LIMIT - 1) + '…' : text;
}

// A digest for a run that FAILED, or aborted before it had a round.
//
// The rule this exists for: a crashed run that reports nothing is worse than one that
// reports failing. An orchestrator parsing stdout must get the same shape every time,
// so a failure is a digest with a `failure` block — not an error string, not an empty
// body, and never a partial JSON fragment.
//
// When a round exists the real digest is returned with the failure attached, so the
// counts it reached are preserved. When the run died before opening one (git pull
// diverged, doctor refused, the lock was held), a minimal envelope with the same top
// level keys is returned instead.
function failureEnvelope({ roundId = '', stage = 'unknown', error = '', persona = '' } = {}) {
  const failure = {
    failed: true,
    stage,
    error: String(error || '').replace(/\s+/g, ' ').slice(0, 500),
    at: new Date().toISOString(),
  };

  if (roundId) {
    const d = forRound(roundId);
    if (d) return { ...d, failure, needsAttention: d.needsAttention || true };
  }

  // No round: same keys, zeroed, so a consumer needs no special case.
  const zero = { evaluated: 0, applied: 0, skipped: 0, errored: 0, dryRun: 0, batches: 0, ledgerSubmissions: 0, remaining: null, lastJob: null, lastUpdateAt: null };
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    round: {
      id: roundId || null,
      persona: persona || '',
      profileKey: '',
      machineId: machine.id(),
      hostname: machine.hostname(),
      startedAt: null,
      completedAt: null,
      durationSec: null,
      running: false,
      target: 0,
      stopped: null,
    },
    counts: zero,
    tailoring: { state: 'off', accepted: 0, rejected: 0, fallback: 0 },
    attention: attentionBlock(null, { allOpen: true }),
    friction: frictionBlock(),
    blocked: { total: 0, byKind: {}, emptyDiscoveryResults: 0, shareOfEvaluated: 0, note: null },
    host: hostBlock(),
    companies: [],
    needsAttention: true,
    failure,
  };
}

module.exports = { forRound, since, telegram, failureEnvelope, attentionBlock, frictionBlock, blockedBlock, tailoringBlock, hostBlock, LIMIT };
