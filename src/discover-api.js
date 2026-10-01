// Jobbie-style discovery: sweep public ATS APIs (no login, no browser, live jobs only).
//
// This replaces the LinkedIn-DOM bottleneck (which kept stalling on expired
// sessions / authwalls) as the PRIMARY discovery surface. It hits the public
// JSON job-board APIs of every company token in data/companies.json across
// Greenhouse, Lever, Ashby, Workable, and SmartRecruiters, filters by the
// active persona's role keywords + US/remote eligibility, dedupes against
// seen-jobs.csv and the existing queue, and appends matches to queue-<persona>.json.
//
//   PERSONA=qa        node src/discover-api.js
//   PERSONA=cloud     node src/discover-api.js --max 120
//   PERSONA=fullstack node src/discover-api.js --ats greenhouse,lever
//
// The apply runner (src/index.js) then processes queue-<persona>.json exactly
// as before — discovery and application stay decoupled.

const path = require('path');
const fs = require('fs');
const { fetchBoard, ATS_LIST } = require('./ats-apis');
const { loadSeenUrls } = require('./log');
const answers = require('./answers'); // throws if PERSONA unset — intentional

// Role / company / location / recency policy is shared with every other
// discovery runner (community registry, aggregator feeds) via one module, so a
// new source can never queue jobs this one would have rejected.
// Env knobs: REMOTE_ONLY=1, ALLOW_BIG=1, RECENT_DAYS=N, TITLE_FILTER=<regex>.
const {
  blockCompany, locationEligible, titleEligible, recentEnough, DEFENSE_TOKENS,
} = require('./util/eligibility');

const PERSONA = answers.persona;
const COMPANIES_FILE = path.resolve(__dirname, '..', 'data', 'companies.json');
const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);

function arg(name, def) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}

const MAX = parseInt(arg('max', '120'), 10);
const ATS_FILTER = (arg('ats', '') || '').split(',').map((s) => s.trim()).filter(Boolean);

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

// Priority companies (data/priority-companies.json) are exempt from the BIG-CO and
// aggregator filters - that is the whole point of naming them. They are NEVER exempt
// from isPersonalExclude, so active interviews, the user's own companies and former
// employers (data/personal-exclude.json) stay blocked even if listed here by mistake.
const { isPersonalExclude, core: coreName } = require('./util/company-filter');
function loadPriorityTokens(persona) {
  try {
    const pf = path.join(__dirname, '..', 'data', 'priority-companies.json');
    if (!fs.existsSync(pf)) return { byAts: {}, all: new Set() };
    const pj = JSON.parse(fs.readFileSync(pf, 'utf8'));
    const byAts = {};
    const all = new Set();
    for (const scope of [pj[persona], pj._all]) {
      if (!scope) continue;
      for (const [ats, toks] of Object.entries(scope)) {
        if (!Array.isArray(toks)) continue;
        byAts[ats] = (byAts[ats] || []).concat(toks);
        for (const t of toks) all.add(coreName(t));
      }
    }
    return { byAts, all };
  } catch (e) {
    console.log(`    priority list unreadable: ${e.message}`);
    return { byAts: {}, all: new Set() };
  }
}
const PRIORITY = loadPriorityTokens(PERSONA);
const allowedByPriority = (name) =>
  !!name && PRIORITY.all.has(coreName(name)) && !isPersonalExclude(name);

async function main() {
  if (!fs.existsSync(COMPANIES_FILE)) {
    console.error(`Missing ${COMPANIES_FILE}`);
    process.exit(1);
  }
  const companies = JSON.parse(fs.readFileSync(COMPANIES_FILE, 'utf8'));
  const persona = answers; // active persona answers object
  const seen = loadSeenUrls();
  const existing = loadQueue();
  const known = new Set(existing.map((j) => (j.url || '').split('?')[0].split('#')[0]));

  let atsList = ATS_LIST.filter((a) => companies[a] && companies[a].length);
  if (ATS_FILTER.length) atsList = atsList.filter((a) => ATS_FILTER.includes(a));
  // Cap tokens per ATS to avoid sweeping all 9k+ tokens when queue only needs ~120
  const TOKEN_CAP = parseInt(process.env.TOKEN_CAP || '0', 10);

  console.log(`\nAPI Discovery — persona: ${PERSONA} (${persona.fullName})`);
  console.log(`Match: ${persona.matchKeywords}`);
  console.log(`ATS: ${atsList.join(', ')}`);
  console.log(`Target: up to ${MAX} new candidates\n`);

  const collected = [];
  const stats = {};

  const CONC = 80; // concurrent board fetches — increased for speed

  const collect = (ats, jobs) => {
    for (const j of jobs) {
      if (collected.length >= MAX) break;
      // Role fit + focused TITLE_FILTER + qa-hardware + federal/clearance rules.
      if (!titleEligible(j.title, persona)) continue;
      if (blockCompany(j.company) && !allowedByPriority(j.company)) continue;                          // drop aggregators (+ big-cos unless ALLOW_BIG)
      if (!locationEligible(j.location, j.remote, j.workplaceType, j.title)) continue; // remote-US or hybrid-TX only
      if (!recentEnough(j.posted)) continue;                          // recent postings only
      const url = (j.url || '').split('?')[0].split('#')[0];
      if (!url || seen.has(url) || known.has(url)) continue;         // dedupe
      known.add(url);
      // Carry the ATS remote determination into the queue so clean-queue can
      // trust it (a role flagged remote but tagged with an HQ city like "(San
      // Francisco)" IS remote — the city is just the company location).
      // `discoveredAt` and `postedUnknown` exist because 71% of queued rows arrive with
      // no posting date, which makes the recency filter a no-op for them. Stamping when
      // WE saw the row gives the apply side something to age against, and flagging the
      // gap keeps it countable instead of invisible.
      collected.push({
        url, company: j.company, role: j.title, location: j.location,
        remote: !!j.remote, workplaceType: j.workplaceType || '',
        posted: j.posted || null,
        postedUnknown: !j.posted,
        discoveredAt: new Date().toISOString(),
        source: `api:${ats}`, persona: PERSONA, status: 'pending',
      });
    }
  };

  for (const ats of atsList) {
    if (collected.length >= MAX) break;
    let tokens = companies[ats].filter((t) =>
      !DEFENSE_TOKENS.test(t) && (allowedByPriority(t) || !blockCompany(t)));
    // PRIORITY + ROTATION.
    //
    // This line used to be a bare `tokens.slice(0, TOKEN_CAP)`. companies.json is
    // sorted, so with the orchestrator's TOKEN_CAP=500 against 9,666 greenhouse
    // tokens the sweep only ever reached names starting '0','1','a' - the same ~2%
    // of the catalog every night, for every persona. Two changes:
    //
    //   1. PRIORITY tokens (data/priority-companies.json) go first and are never
    //      truncated, so a named target is always swept however big the catalog is.
    //   2. The remaining budget starts from a rotating offset persisted per
    //      (persona, ats), so consecutive runs walk forward through the catalog and
    //      wrap, instead of re-reading the same alphabetical head forever.
    const priority = tokens.filter((t) => (PRIORITY.byAts[ats] || []).includes(t));

    if (TOKEN_CAP > 0) {
      const rest = tokens.filter((t) => !priority.includes(t));
      const budget = Math.max(0, TOKEN_CAP - priority.length);
      const offFile = path.join(__dirname, '..', '.state', 'discovery-offsets.json');
      let offs = {};
      try { if (fs.existsSync(offFile)) offs = JSON.parse(fs.readFileSync(offFile, 'utf8')); } catch {}
      const key = `${PERSONA}:${ats}`;
      const start = rest.length ? ((Number(offs[key]) || 0) % rest.length) : 0;
      const window = budget >= rest.length
        ? rest
        : rest.slice(start, start + budget).concat(
            start + budget > rest.length ? rest.slice(0, start + budget - rest.length) : []);
      offs[key] = rest.length ? (start + budget) % rest.length : 0;
      try {
        fs.mkdirSync(path.dirname(offFile), { recursive: true });
        fs.writeFileSync(offFile, JSON.stringify(offs, null, 2));
      } catch (e) { console.log(`    could not persist discovery offset: ${e.message}`); }
      tokens = priority.concat(window);
      console.log(`    ${ats}: ${priority.length} priority + ${window.length} rotating (offset ${start}/${rest.length})`);
    } else if (priority.length) {
      tokens = priority.concat(tokens.filter((t) => !priority.includes(t)));
    }
    let boardHits = 0, boardScanned = 0;
    const before = collected.length;
    for (let i = 0; i < tokens.length && collected.length < MAX; i += CONC) {
      const batch = tokens.slice(i, i + CONC);
      const results = await Promise.all(batch.map((t) => fetchBoard(ats, t)));
      for (const jobs of results) { boardScanned += jobs.length; if (jobs.length) boardHits++; collect(ats, jobs); if (collected.length >= MAX) break; }
    }
    stats[ats] = { boards: `${boardHits}`, jobs: boardScanned, matched: collected.length - before };
    console.log(`  ${ats.padEnd(16)} live-boards ${String(boardHits).padEnd(6)} jobs ${String(boardScanned).padEnd(6)} → matched ${collected.length - before}`);
  }

  // Prioritize the queue so the apply runner spends its budget on jobs most
  // likely to actually submit: remote + software-QA titles + captcha-passable
  // ATSs (Greenhouse/Ashby/CareerPuck) first; deprioritize hardware/defense/
  // onsite and the anti-bot-walled ATSs (Lever upload, SmartRecruiters DataDome).
  const score = (j) => {
    const t = `${j.role} ${j.location || ''}`;
    let s = 0;
    if (/remote/i.test(t)) s += 3;
    if (/SDET|QA Automation|Quality Engineer|Software.*Test|Test Automation|Automation Engineer|Playwright|Cypress|Selenium|Software Engineer in Test|QA Engineer/i.test(j.role)) s += 3;
    // Hardware / manufacturing / physical-quality roles → not software QA.
    if (/\b(firmware|hardware|electrical|mechanical|actuator|\bRF\b|wafer|manufacturing|\blab\b|robotics|silicon|FPGA|PCB|optical|battery|propulsion|flight|supplier quality|process quality|design assurance|incoming inspection|CAPA|AS9100|ISO ?9001|aerospace|aviation|production|weld|machinist|calibration|2nd shift|3rd shift)\b/i.test(t)) s -= 5;
    // Onsite (a city named, no remote) → deprioritize vs remote.
    if (!/remote/i.test(t) && /[A-Z][a-z]+,\s*(?:[A-Z]{2}|California|Texas|New York|Massachusetts)/.test(t)) s -= 2;
    const ats = (j.source || '').replace('api:', '');
    if (/greenhouse|ashby|careerpuck/.test(ats)) s += 2;
    if (/smartrecruiters|lever/.test(ats)) s -= 1;
    return s;
  };
  const merged = existing.concat(collected).sort((a, b) => score(b) - score(a));
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(merged, null, 2));

  console.log(`\nCollected ${collected.length} new candidates (queue now ${merged.length}).`);
  console.log(`Wrote ${QUEUE_FILE}`);
  if (collected.length) {
    console.log('\nSample:');
    collected.slice(0, 10).forEach((j) => console.log(`  [${j.source}] ${j.company} — ${j.role} (${j.location || 'n/a'})`));
  }
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
