// Append-only application + outcome ledger.
//
// Replaces "grep the CSV for the URL" with the four-way duplicate check
// job-application-agent uses (internal id, canonical URL, employer job id,
// company+role alias) plus a same-company reapply cooldown, and adds an
// outcomes ledger so the pile of submissions can actually be analysed.
const crypto = require('crypto');
const paths = require('./paths');
const { append, readAll } = require('./ndjson');
const config = require('./config');
const { canonicalizeUrl, employerJobId, provider, companyKey, roleKey } = require('./canonical');

const SCHEMA = 1;
const OUTCOMES = ['submitted', 'acknowledged', 'screen', 'assessment', 'interview', 'offer', 'hired', 'rejected', 'ghosted', 'withdrawn'];
const TERMINAL = new Set(['offer', 'hired', 'rejected', 'withdrawn']);
const POSITIVE = new Set(['screen', 'assessment', 'interview', 'offer', 'hired']);
const REJECTION_REASONS = [
  'position-closed', 'more-competitive-candidate', 'seniority-mismatch', 'skill-gap',
  'compensation-mismatch', 'location-or-work-mode', 'work-authorization', 'no-reason-given', 'unknown',
];
const INTERVIEW_QUALITY = ['promising', 'viable', 'weak', 'dead'];

const newId = () => 'app_' + crypto.randomBytes(9).toString('hex');
const isoNow = () => new Date().toISOString();
const dayOf = (iso) => String(iso || '').slice(0, 10);

function normalize(entry) {
  const url = entry.url || '';
  const canonicalUrl = canonicalizeUrl(url);
  return {
    schema: SCHEMA,
    id: entry.id || newId(),
    ts: entry.ts || isoNow(),
    persona: entry.persona || '',
    company: entry.company || '',
    companyKey: companyKey(entry.company),
    role: entry.role || '',
    roleKey: roleKey(entry.role),
    url,
    canonicalUrl,
    employerJobId: entry.employerJobId || employerJobId(url),
    requisitionId: entry.requisitionId || '',
    applicationChannel: entry.applicationChannel || provider(url),
    discoverySource: entry.discoverySource || 'unknown',
    discoverySourceId: entry.discoverySourceId || '',
    roundId: entry.roundId || '',
    status: entry.status || 'submitted',
    score: entry.score === undefined ? null : entry.score,
    gate: entry.gate || '',
    autoEligible: entry.autoEligible === true,
    confirmation: entry.confirmation || '',
    notes: entry.notes || '',
  };
}

const applications = () => readAll(paths.applications());
const outcomes = () => readAll(paths.outcomes());

// Record a submission. Only ever called after a VISIBLE confirmation — a filled
// form is not a submission.
function add(entry) {
  if (!entry || !entry.url) throw new Error('ledger add: url is required');
  if (!entry.confirmation) throw new Error('ledger add: confirmation evidence is required (a filled form is not a submission)');
  return append(paths.applications(), normalize(entry));
}

function businessDaysBetween(fromIso, toIso) {
  const a = new Date(dayOf(fromIso) + 'T00:00:00Z');
  const b = new Date(dayOf(toIso) + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  let days = 0;
  for (const d = new Date(a); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days++;
  }
  return days;
}

function calendarDaysBetween(fromIso, toIso) {
  const a = new Date(dayOf(fromIso) + 'T00:00:00Z');
  const b = new Date(dayOf(toIso) + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / 86400000);
}

// The pre-submission gate. Returns a decision plus every signal behind it, so a
// caller can stop, ask, or proceed without re-deriving the reasoning.
function check(input = {}) {
  const cfg = config();
  const now = input.now || isoNow();
  const rows = input._rows || applications();
  const outs = input._outcomes || outcomes();

  const canonical = canonicalizeUrl(input.url || '');
  const jobId = input.employerJobId || employerJobId(input.url || '');
  const cKey = companyKey(input.company);
  const rKey = roleKey(input.role);

  let duplicateType = null;
  let duplicateOf = null;
  const hit = (row, type) => { if (!duplicateType) { duplicateType = type; duplicateOf = row.id; } };

  for (const row of rows) {
    if (row.status !== 'submitted') continue;
    if (input.id && row.id === input.id) hit(row, 'ledger-id');
    else if (canonical && row.canonicalUrl === canonical) hit(row, 'canonical-url');
    else if (jobId && row.employerJobId === jobId) hit(row, 'employer-job-id');
    else if (input.requisitionId && row.requisitionId && row.requisitionId === input.requisitionId) hit(row, 'requisition');
  }

  // A same-company/same-role alias is a POSSIBLE duplicate (re-slugged or
  // reposted requisition), not a hard one — it needs a human call.
  const alias = !duplicateType && cKey && rKey
    ? rows.find((r) => r.status === 'submitted' && r.companyKey === cKey && r.roleKey === rKey) || null
    : null;

  // Company reapply history, for a genuinely different role at a known company.
  const companyRows = cKey ? rows.filter((r) => r.status === 'submitted' && r.companyKey === cKey) : [];
  let companyReapply = 'none';
  let lastCompanyApplication = null;
  let daysSinceCompany = null;
  if (companyRows.length) {
    lastCompanyApplication = companyRows.reduce((a, b) => (a.ts > b.ts ? a : b));
    daysSinceCompany = calendarDaysBetween(lastCompanyApplication.ts, now);
    const ids = new Set(companyRows.map((r) => r.id));
    const hasOutcome = outs.some((o) => ids.has(o.applicationId));
    if (hasOutcome) companyReapply = 'follow-up-present';
    else if (daysSinceCompany >= cfg.companyReapplyCooldownDays) companyReapply = 'eligible-after-cooldown';
    else companyReapply = 'cooldown-active';
  }

  const dupOverridden = duplicateType && input.duplicateOverride === 'NEW REQUISITION CONFIRMED';
  const reapplyOverridden = input.companyReapplyOverride === 'CANDIDATE APPROVED EARLY REAPPLICATION';

  let decision = 'proceed';
  const reasons = [];
  if (duplicateType && !dupOverridden) {
    decision = 'stop';
    reasons.push(`hard duplicate (${duplicateType}) of ${duplicateOf}`);
  } else if (duplicateType && dupOverridden) {
    reasons.push(`duplicate (${duplicateType}) overridden as a new requisition`);
  }
  if (decision !== 'stop' && alias) {
    decision = 'ask';
    reasons.push(`possible duplicate: same company + role already applied (${alias.id}, ${dayOf(alias.ts)})`);
  }
  if (decision !== 'stop' && (companyReapply === 'cooldown-active' || companyReapply === 'follow-up-present')) {
    if (reapplyOverridden) {
      reasons.push(`company reapply (${companyReapply}) approved by candidate`);
    } else {
      decision = 'ask';
      reasons.push(companyReapply === 'cooldown-active'
        ? `company cooldown active: ${daysSinceCompany}/${cfg.companyReapplyCooldownDays} days since ${lastCompanyApplication.company}`
        : `an outcome is already recorded for ${lastCompanyApplication.company} — follow up rather than reapply`);
    }
  }

  return {
    duplicate: Boolean(duplicateType),
    duplicateType,
    duplicateOf,
    aliasMatch: alias ? { id: alias.id, role: alias.role, date: dayOf(alias.ts) } : null,
    companyReapply,
    lastCompanyApplication: lastCompanyApplication
      ? { id: lastCompanyApplication.id, role: lastCompanyApplication.role, date: dayOf(lastCompanyApplication.ts) }
      : null,
    daysSinceCompanyApplication: daysSinceCompany,
    cooldownDays: cfg.companyReapplyCooldownDays,
    canonicalUrl: canonical,
    employerJobId: jobId,
    decision,
    reasons,
  };
}

// Record an outcome. Idempotent: replaying the same event does not append.
function recordOutcome(input = {}) {
  if (!input.applicationId) throw new Error('ledger outcome: applicationId is required');
  if (!OUTCOMES.includes(input.outcome)) {
    throw new Error(`ledger outcome: outcome must be one of ${OUTCOMES.join(', ')}`);
  }
  if (input.reason && !REJECTION_REASONS.includes(input.reason)) {
    throw new Error(`ledger outcome: reason must be one of ${REJECTION_REASONS.join(', ')}`);
  }
  if (input.interviewQuality && !INTERVIEW_QUALITY.includes(input.interviewQuality)) {
    throw new Error(`ledger outcome: interviewQuality must be one of ${INTERVIEW_QUALITY.join(', ')}`);
  }
  const app = applications().find((r) => r.id === input.applicationId);
  if (!app) throw new Error(`ledger outcome: unknown applicationId ${input.applicationId}`);

  const ts = input.ts || isoNow();
  const record = {
    schema: SCHEMA,
    id: 'out_' + crypto.randomBytes(9).toString('hex'),
    ts,
    applicationId: input.applicationId,
    company: app.company,
    companyKey: app.companyKey,
    role: app.role,
    outcome: input.outcome,
    reason: input.reason || '',
    // An inference is never promoted to a candidate fact — it stays labelled.
    reasonBasis: input.reasonBasis === 'explicit' ? 'explicit' : 'inferred',
    interviewQuality: input.interviewQuality || '',
    failurePoint: (input.failurePoint || '').slice(0, 120),
    notes: (input.notes || '').slice(0, 500),
  };

  const dupe = outcomes().some((o) => o.applicationId === record.applicationId
    && o.outcome === record.outcome
    && dayOf(o.ts) === dayOf(record.ts)
    && o.reason === record.reason);
  if (dupe) return { recorded: false, reason: 'identical outcome already recorded', record: null };

  append(paths.outcomes(), record);
  return { recorded: true, record };
}

function tally(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r) || '(none)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
}

function scoreBand(score) {
  if (score == null) return 'unscored';
  if (score >= 90) return '90-100';
  if (score >= 80) return '80-89';
  if (score >= 70) return '70-79';
  return '<70';
}

// The report their `ledger review` produces: what was actually sent, which rows
// were duplicates, and — only for applications old enough to have heard back —
// what converted.
function review(opts = {}) {
  const cfg = config();
  const now = opts.now || isoNow();
  const rows = (opts._rows || applications()).filter((r) => r.status === 'submitted');
  const outs = opts._outcomes || outcomes();

  const byCanonical = new Map();
  let duplicateRows = 0;
  for (const r of rows) {
    const key = r.employerJobId || r.canonicalUrl || r.id;
    if (byCanonical.has(key)) duplicateRows++;
    else byCanonical.set(key, r);
  }
  const unique = [...byCanonical.values()];

  const outcomeByApp = new Map();
  for (const o of outs) {
    const cur = outcomeByApp.get(o.applicationId) || [];
    cur.push(o);
    outcomeByApp.set(o.applicationId, cur);
  }

  const mature = unique.filter((r) => businessDaysBetween(r.ts, now) >= cfg.outcomeMaturityBusinessDays);
  const matureWithPositive = mature.filter((r) => (outcomeByApp.get(r.id) || []).some((o) => POSITIVE.has(o.outcome)));
  const matureWithAny = mature.filter((r) => (outcomeByApp.get(r.id) || []).length > 0);

  const segment = (keyFn) => {
    const m = new Map();
    for (const r of mature) {
      const k = keyFn(r) || '(none)';
      const s = m.get(k) || { applications: 0, responses: 0, positive: 0 };
      s.applications++;
      const os = outcomeByApp.get(r.id) || [];
      if (os.length) s.responses++;
      if (os.some((o) => POSITIVE.has(o.outcome))) s.positive++;
      m.set(k, s);
    }
    return Object.fromEntries([...m.entries()]
      .sort((a, b) => b[1].applications - a[1].applications)
      .map(([k, s]) => [k, { ...s, positiveRate: s.applications ? +(s.positive / s.applications).toFixed(3) : 0 }]));
  };

  const ackFile = paths.reviewAck();
  let acknowledged = { uniqueSubmissions: 0, matureApplications: 0, ts: null };
  try { acknowledged = JSON.parse(require('fs').readFileSync(ackFile, 'utf8')); } catch { /* first run */ }

  return {
    generatedAt: now,
    totals: {
      ledgerRows: rows.length,
      uniqueSubmissions: unique.length,
      duplicateRows,
      outcomesRecorded: outs.length,
      matureApplications: mature.length,
    },
    conversions: {
      maturityBusinessDays: cfg.outcomeMaturityBusinessDays,
      responseRate: mature.length ? +(matureWithAny.length / mature.length).toFixed(3) : 0,
      positiveRate: mature.length ? +(matureWithPositive.length / mature.length).toFixed(3) : 0,
    },
    byDiscoverySource: segment((r) => r.discoverySource),
    byApplicationChannel: segment((r) => r.applicationChannel),
    byScoreBand: segment((r) => scoreBand(r.score)),
    byPersona: segment((r) => r.persona),
    volumeByChannel: tally(rows, (r) => r.applicationChannel),
    volumeBySource: tally(rows, (r) => r.discoverySource),
    rejectionReasons: tally(outs.filter((o) => o.outcome === 'rejected'), (o) => o.reason),
    interviewQuality: tally(outs.filter((o) => o.interviewQuality), (o) => o.interviewQuality),
    failurePoints: tally(outs.filter((o) => o.failurePoint), (o) => o.failurePoint),
    due: {
      // Generating a report is not acknowledging it — the counters only move on
      // an explicit review-ack.
      hygieneReview: unique.length - (acknowledged.uniqueSubmissions || 0) >= cfg.hygieneReviewEvery,
      outcomeReview: mature.length - (acknowledged.matureApplications || 0) >= cfg.outcomeReviewMinApps,
      newSinceAck: {
        uniqueSubmissions: unique.length - (acknowledged.uniqueSubmissions || 0),
        matureApplications: mature.length - (acknowledged.matureApplications || 0),
      },
    },
    lastAcknowledged: acknowledged,
  };
}

function reviewAck(opts = {}) {
  const r = review(opts);
  const record = {
    ts: isoNow(),
    uniqueSubmissions: r.totals.uniqueSubmissions,
    matureApplications: r.totals.matureApplications,
    note: (opts.note || '').slice(0, 300),
  };
  require('fs').writeFileSync(paths.reviewAck(), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

module.exports = {
  add, check, recordOutcome, review, reviewAck,
  applications, outcomes, normalize, newId,
  businessDaysBetween, calendarDaysBetween, scoreBand,
  OUTCOMES, REJECTION_REASONS, INTERVIEW_QUALITY, TERMINAL, POSITIVE, SCHEMA,
};
