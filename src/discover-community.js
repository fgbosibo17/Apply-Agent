// Discovery method: the job-application-agent community registry (READ-ONLY).
//
// Upstream project: https://github.com/vaibhavarora14/job-application-agent
// Their agent asks every installation to contribute the canonical public URL of
// each job it confirmed a submission to, and publishes the maintainer-reviewed
// result on two anonymous GET endpoints:
//
//   GET /v1/jobs?limit&cursor   confirmed public job links (company, role,
//                               applicationChannel, providerUrl, first/lastSeen)
//   GET /v1/sources             maintainer-reviewed repeatable discovery surfaces
//
// This is the one sourcing mechanism they have that we do not: a live feed of
// jobs that a real person actually reached the submit button on. Unlike the
// remote-job aggregators, the URLs here are EMPLOYER/ATS URLs, so they are both
// directly queueable and a rich source of new board tokens.
//
// WE ONLY READ. This script sends no installation id, no candidate data, no
// ledger rows, no telemetry, and never calls the POST contribution endpoints —
// consistent with data/sources.json's promise that no source metadata leaves the
// machine. Nothing here opts this repo into their community sharing.
//
//   node src/discover-community.js                 # harvest tokens only
//   PERSONA=qa node src/discover-community.js      # + queue persona matches
//   node src/discover-community.js --pages 10 --no-tokens
//
// Bounded: `--pages` caps pagination (100 jobs per page).

const path = require('path');
const fs = require('fs');
const { fetchJson, fetchBoard, extractAtsTokens, ATS_LIST } = require('./ats-apis');
const { employerJobId, canonicalizeUrl, provider } = require('./core/canonical');
const { loadSeenUrls } = require('./log');
const { blockCompany, jobEligible, DEFENSE_TOKENS } = require('./util/eligibility');

const ENDPOINT = (process.env.COMMUNITY_REGISTRY_URL
  || 'https://job-application-agent-telemetry.varora1406.workers.dev').replace(/\/$/, '');
const COMPANIES_FILE = path.resolve(__dirname, '..', 'data', 'companies.json');
const SOURCES_FILE = path.resolve(__dirname, '..', 'data', 'sources.json');

function arg(name, def) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const has = (name) => process.argv.includes(`--${name}`);

const PAGES = parseInt(arg('pages', '10'), 10);
const CONC = 20;
const stripQs = (u) => (u || '').split('?')[0].split('#')[0];

async function fetchCommunityJobs(pages) {
  const jobs = [];
  let cursor = null;
  for (let p = 0; p < pages; p++) {
    const q = new URLSearchParams({ limit: '100' });
    if (cursor) q.set('cursor', cursor);
    const { code, json } = await fetchJson(`${ENDPOINT}/v1/jobs?${q}`);
    if (!json || !Array.isArray(json.jobs)) {
      if (p === 0) console.log(`  registry /v1/jobs unavailable (HTTP ${code}) — skipping`);
      break;
    }
    jobs.push(...json.jobs);
    cursor = json.nextCursor || null;
    if (!cursor) break;
  }
  return jobs;
}

async function fetchCommunitySources() {
  const { json } = await fetchJson(`${ENDPOINT}/v1/sources`);
  return json && Array.isArray(json.sources) ? json.sources : [];
}

// The registry publishes company, role, applicationChannel and providerUrl — but
// NO location and no "is this still open". Both matter: the contributors are
// worldwide (a "Software Engineer - London" row would sail past a remote-US
// filter if we assumed unknown == remote-US), and a confirmed application from
// weeks ago says nothing about the req being live today.
//
// So instead of trusting the registry row, we use it only as a POINTER: parse the
// ATS + board token out of providerUrl, fetch that employer board once through
// the same src/ats-apis.js clients the main sweep uses, and match the row back to
// a live posting by employerJobId (which collapses host aliases and tracking
// params). A row that no longer appears on its own board is dropped — that is
// the recency and location check in one step, taken from the employer, not the
// aggregator.
function boardRef(url) {
  const canon = canonicalizeUrl(url || '');
  const ats = provider(canon);
  if (!ATS_LIST.includes(ats)) return null;
  let token = '';
  try {
    const u = new URL(canon);
    token = (u.pathname.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (ats === 'greenhouse' && u.searchParams.get('for')) token = u.searchParams.get('for').toLowerCase();
  } catch { return null; }
  if (!token || token === 'jobs' || token === 'embed') return null;
  return { ats, token };
}

async function resolveAgainstBoards(jobs) {
  // Group rows by the board we need to fetch, so each employer board is hit once.
  const groups = new Map();
  const out = jobs.map((registry) => ({ registry, live: null }));
  out.forEach((row) => {
    const ref = boardRef(row.registry.providerUrl) || boardRef(row.registry.url);
    if (!ref) return;
    if (DEFENSE_TOKENS.test(ref.token) || blockCompany(ref.token) || blockCompany(row.registry.company)) return;
    const key = `${ref.ats}:${ref.token}`;
    if (!groups.has(key)) groups.set(key, { ...ref, rows: [] });
    groups.get(key).rows.push(row);
  });

  const keys = [...groups.keys()];
  for (let i = 0; i < keys.length; i += CONC) {
    const batch = keys.slice(i, i + CONC);
    await Promise.all(batch.map(async (key) => {
      const g = groups.get(key);
      const liveJobs = await fetchBoard(g.ats, g.token);
      if (!liveJobs.length) return;
      const byId = new Map();
      const byUrl = new Map();
      for (const lj of liveJobs) {
        const id = employerJobId(lj.url);
        if (id) byId.set(id, lj);
        byUrl.set(canonicalizeUrl(lj.url), lj);
      }
      for (const row of g.rows) {
        const id = employerJobId(row.registry.url);
        row.live = (id && byId.get(id)) || byUrl.get(canonicalizeUrl(row.registry.url)) || null;
      }
    }));
  }
  return out;
}

// Merge harvested tokens into data/companies.json (same idiom as discover-hn.js:
// preserve existing, add new, dedupe lowercase, sort).
function mergeTokens(harvested) {
  const companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  let added = 0;
  const perAts = {};
  for (const a of ATS_LIST) {
    const existing = new Set((companies[a] || []).map((s) => s.toLowerCase()));
    const merged = companies[a] ? [...companies[a]] : [];
    let n = 0;
    for (const tok of harvested[a] || []) {
      if (existing.has(tok)) continue;
      if (DEFENSE_TOKENS.test(tok) || blockCompany(tok)) continue;
      merged.push(tok); existing.add(tok); added++; n++;
    }
    perAts[a] = n;
    companies[a] = merged.sort((x, y) => x.localeCompare(y));
  }
  fs.writeFileSync(COMPANIES_FILE, JSON.stringify(companies, null, 2));
  return { added, perAts, totals: ATS_LIST.map((a) => `${a}:${companies[a].length}`).join('  ') };
}

// Report community-reviewed repeatable surfaces we have not catalogued. We do
// NOT auto-write them: data/sources.json is a reviewed local catalog, and an
// unreviewed remote entry landing in it silently would defeat that.
function reportNewSources(remote) {
  let known = [];
  try { known = JSON.parse(fs.readFileSync(SOURCES_FILE, 'utf8')).sources || []; } catch { /* ignore */ }
  const haveUrl = new Set(known.map((s) => stripQs(s.baseUrl || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase()));
  const haveId = new Set(known.map((s) => s.id));
  return remote.filter((s) => {
    const key = stripQs(s.baseUrl || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').toLowerCase();
    return !haveId.has(s.sourceId) && !haveUrl.has(key);
  });
}

async function main() {
  console.log('\nCommunity registry discovery (read-only)');
  console.log(`Endpoint: ${ENDPOINT}  — GET only, nothing is transmitted about this machine\n`);

  const jobs = await fetchCommunityJobs(PAGES);
  console.log(`Fetched ${jobs.length} confirmed community job links.`);

  // ── 1. Token harvest: providerUrl is the employer's ATS board root ─────────
  if (!has('no-tokens') && jobs.length) {
    const text = jobs.map((j) => `${j.url || ''} ${j.providerUrl || ''}`).join('\n');
    const toks = extractAtsTokens(text);
    const harvested = {};
    ATS_LIST.forEach((a) => (harvested[a] = [...(toks[a] || [])]));
    console.log(`Tokens seen: ${ATS_LIST.map((a) => `${a}:${harvested[a].length}`).join(' ')}`);
    const { added, perAts, totals } = mergeTokens(harvested);
    console.log(`Added ${added} NEW tokens (${ATS_LIST.map((a) => `${a}:${perAts[a]}`).join(' ')}).`);
    console.log(`companies.json now: ${totals}`);
  }

  // ── 2. Queue only leads we can RE-VERIFY on the employer's own board ───────
  if (process.env.PERSONA && jobs.length) {
    const persona = require('./answers');
    const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${persona.persona}.json`);
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { /* new queue */ }
    const seen = loadSeenUrls();
    const known = new Set(existing.map((j) => stripQs(j.url)));

    const resolved = await resolveAgainstBoards(jobs);
    const collected = [];
    const drops = { unresolved: 0, filtered: 0, duplicate: 0 };
    for (const { registry, live } of resolved) {
      if (!live) { drops.unresolved++; continue; }
      const url = stripQs(live.url);
      if (!url || !/^https:\/\//i.test(url)) { drops.unresolved++; continue; }
      if (seen.has(url) || known.has(url)) { drops.duplicate++; continue; }
      // `live` carries the board's REAL title, location, remote flag and date,
      // so the shared eligibility rules apply exactly as in discover-api.js.
      if (!jobEligible(live, persona)) { drops.filtered++; continue; }
      known.add(url);
      collected.push({
        url,
        company: live.company || registry.company || '',
        role: live.title,
        location: live.location,
        remote: !!live.remote,
        workplaceType: live.workplaceType || '',
        posted: live.posted || null,
        source: 'community:jobs',
        sourceId: 'community-job-registry',
        communityJobId: registry.jobId || '',
        persona: persona.persona,
        status: 'pending',
      });
    }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(existing.concat(collected), null, 2));
    console.log(`\nRe-verified on the employer board: ${resolved.filter((r) => r.live).length}/${jobs.length}`);
    console.log(`  dropped — not live/not on a supported ATS ${drops.unresolved}, ineligible ${drops.filtered}, already known ${drops.duplicate}`);
    console.log(`Queued ${collected.length} community leads for persona ${persona.persona} (queue now ${existing.length + collected.length}).`);
    collected.slice(0, 10).forEach((j) => console.log(`  ${j.company} — ${j.role} (${j.location || 'n/a'})`));
    console.log(`Wrote ${QUEUE_FILE}`);
  } else if (!process.env.PERSONA) {
    console.log('\n(no PERSONA set — token harvest only; set PERSONA=qa|cloud|fullstack to also queue leads)');
  }

  // ── 3. Repeatable surfaces others found that we have not catalogued ────────
  const remoteSources = await fetchCommunitySources();
  const fresh = reportNewSources(remoteSources);
  console.log(`\nCommunity discovery surfaces: ${remoteSources.length} published, ${fresh.length} not in our catalog.`);
  fresh.forEach((s) => console.log(`  + ${s.name} — ${s.baseUrl} (${s.kind}, ${(s.regions || []).join('/')}, session=${!!s.requiresSession})`));
  if (fresh.length) {
    console.log('\nReview then add with:');
    console.log(`  echo '${JSON.stringify({ id: fresh[0].sourceId, name: fresh[0].name, kind: fresh[0].kind, baseUrl: fresh[0].baseUrl, regions: fresh[0].regions, requiresSession: !!fresh[0].requiresSession, automation: 'agent', notes: 'community-reviewed upstream registry entry' })}' | npm run agent -- sources add --stdin`);
  }
  console.log('\nNext: PERSONA=<p> node src/discover-api.js  (sweeps the expanded token pool)');
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
