// Discovery-source catalog (local only).
//
// Ported from job-application-agent's SOURCES.json idea, minus the community
// registry: this agent transmits nothing. A source is a lead surface, never an
// endorsement and never the application channel — every lead still resolves to
// the employer's own ATS before assessment.
//
// Two things the upstream catalog does not do, added here because we have 2k+
// real submissions to learn from:
//   * `automation` records HOW a surface is worked — a `runner` script, the
//     Claude-driven browser (`agent`), or by hand (`manual`) — so `sources list`
//     never implies a surface is automated when it isn't.
//   * `labels` join a source to the discoverySource strings the runners write
//     into the ledger, which is what lets `sources stats` report volume and
//     conversion PER SOURCE instead of guessing where the good jobs came from.
const fs = require('fs');
const paths = require('./paths');

const KINDS = [
  'ats-api', 'search', 'job-board', 'startup-network', 'aggregator', 'feed',
  'direct-employer', 'professional-network', 'social-feed', 'community-thread',
  'curated-board', 'inbound', 'user-supplied', 'one-off',
];
const AUTOMATION = ['runner', 'agent', 'manual'];

function load() {
  try { return JSON.parse(fs.readFileSync(paths.sourcesCatalog, 'utf8')); } catch { return { version: 0, sources: [] }; }
}

function list(filter = {}) {
  const { sources } = load();
  const want = (arr, val) => !arr || !arr.length || (val || []).some((v) => arr.includes(v));
  return sources.filter((s) => {
    if (filter.kinds && filter.kinds.length && !filter.kinds.includes(s.kind)) return false;
    if (filter.automation && filter.automation.length && !filter.automation.includes(s.automation)) return false;
    if (filter.requiresSession !== undefined && s.requiresSession !== filter.requiresSession) return false;
    if (!want(filter.regions, s.regions)) return false;
    if (!want(filter.roleFamilies, s.roleFamilies)) return false;
    return true;
  });
}

function get(id) { return load().sources.find((s) => s.id === id) || null; }

// discoverySource label (what a runner writes: "api:greenhouse", "builtin",
// "google-ashby", "Manual") -> catalog id. Falls back to a prefix match so a
// new "retry:greenhouse"-style label still lands on the right source, then to
// an exact id match, then to '' so the ledger keeps the raw label either way.
function resolveId(label) {
  if (!label) return '';
  const norm = String(label).trim().toLowerCase();
  const sources = load().sources;
  for (const s of sources) {
    if ((s.labels || []).some((l) => String(l).toLowerCase() === norm)) return s.id;
  }
  const suffix = norm.includes(':') ? norm.split(':').pop() : norm;
  for (const s of sources) {
    if ((s.labels || []).some((l) => String(l).toLowerCase().split(':').pop() === suffix)) return s.id;
  }
  return sources.some((s) => s.id === norm) ? norm : '';
}

// Add a newly discovered repeatable surface to the local catalog. One-off job
// detail URLs, recruiter profiles and referral links are rejected — they are
// leads, not sources.
function add(input = {}) {
  if (!input.id || !input.name) throw new Error('sources add: id and name are required');
  if (input.kind && !KINDS.includes(input.kind)) throw new Error(`sources add: kind must be one of ${KINDS.join(', ')}`);
  if (input.automation && !AUTOMATION.includes(input.automation)) throw new Error(`sources add: automation must be one of ${AUTOMATION.join(', ')}`);
  if (input.baseUrl && /\/(jobs?|postings?|job-detail)\/[^/]+$/i.test(input.baseUrl)) {
    throw new Error('sources add: that looks like a single job posting, not a repeatable discovery surface');
  }
  const db = load();
  if (db.sources.some((s) => s.id === input.id)) throw new Error(`sources add: ${input.id} already exists`);
  db.sources.push({
    id: input.id,
    name: input.name,
    kind: input.kind || 'job-board',
    baseUrl: input.baseUrl || '',
    regions: input.regions || ['global'],
    roleFamilies: input.roleFamilies || ['engineering'],
    requiresSession: input.requiresSession === true,
    access: input.access || (input.requiresSession === true ? 'session' : 'public'),
    verification: input.verification || 'direct-employer-or-ats',
    automation: input.automation || 'agent',
    runner: input.runner || null,
    labels: input.labels || [],
    yield: 'unmeasured',
    notes: (input.notes || '').slice(0, 300),
  });
  db.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(paths.sourcesCatalog, JSON.stringify(db, null, 2) + '\n');
  return db.sources[db.sources.length - 1];
}

// Join the catalog to the ledger: what each source actually produced.
//
// `dark` are catalogued surfaces with zero submissions — either untapped or not
// worth keeping. `unattributed` are ledger labels no catalog entry claims, which
// is the signal that a runner is writing a label the catalog does not know yet.
function stats() {
  const ledger = require('./ledger');
  const report = ledger.review();
  const catalog = load().sources;

  const rollup = new Map();
  const claim = (id) => {
    if (!rollup.has(id)) rollup.set(id, { id, submissions: 0, mature: 0, responses: 0, positive: 0, labels: [] });
    return rollup.get(id);
  };

  const unattributed = {};
  for (const [label, count] of Object.entries(report.volumeBySource || {})) {
    const id = resolveId(label);
    if (!id) { unattributed[label] = count; continue; }
    const r = claim(id);
    r.submissions += count;
    if (!r.labels.includes(label)) r.labels.push(label);
  }
  for (const [label, seg] of Object.entries(report.byDiscoverySource || {})) {
    const id = resolveId(label);
    if (!id) continue;
    const r = claim(id);
    r.mature += seg.applications;
    r.responses += seg.responses;
    r.positive += seg.positive;
  }

  const sources = catalog
    .map((s) => {
      const r = rollup.get(s.id) || { submissions: 0, mature: 0, responses: 0, positive: 0, labels: [] };
      return {
        id: s.id,
        name: s.name,
        kind: s.kind,
        automation: s.automation,
        requiresSession: !!s.requiresSession,
        declaredYield: s.yield || 'unmeasured',
        submissions: r.submissions,
        matureApplications: r.mature,
        responses: r.responses,
        positive: r.positive,
        positiveRate: r.mature ? +(r.positive / r.mature).toFixed(3) : 0,
        labels: r.labels,
      };
    })
    .sort((a, b) => b.submissions - a.submissions);

  return {
    generatedAt: report.generatedAt,
    outcomesRecorded: report.totals.outcomesRecorded,
    // Conversion columns are meaningless until outcomes exist; say so rather
    // than letting a wall of 0.0 read as "no source ever converted".
    conversionUsable: report.totals.outcomesRecorded > 0,
    sources,
    dark: sources.filter((s) => s.submissions === 0).map((s) => s.id),
    unattributed,
  };
}

module.exports = { list, get, add, load, resolveId, stats, KINDS, AUTOMATION };
