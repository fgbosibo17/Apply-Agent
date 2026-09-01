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

  console.log(`\nAPI Discovery — persona: ${PERSONA} (${persona.fullName})`);
  console.log(`Match: ${persona.matchKeywords}`);
  console.log(`ATS: ${atsList.join(', ')}`);
  console.log(`Target: up to ${MAX} new candidates\n`);

  const collected = [];
  const stats = {};

  const CONC = 20; // concurrent board fetches — the pool is now thousands of tokens

  const collect = (ats, jobs) => {
    for (const j of jobs) {
      if (collected.length >= MAX) break;
      // Role fit + focused TITLE_FILTER + qa-hardware + federal/clearance rules.
      if (!titleEligible(j.title, persona)) continue;
      if (blockCompany(j.company)) continue;                          // drop aggregators (+ big-cos unless ALLOW_BIG)
      if (!locationEligible(j.location, j.remote, j.workplaceType, j.title)) continue; // remote-US or hybrid-TX only
      if (!recentEnough(j.posted)) continue;                          // recent postings only
      const url = (j.url || '').split('?')[0].split('#')[0];
      if (!url || seen.has(url) || known.has(url)) continue;         // dedupe
      known.add(url);
      // Carry the ATS remote determination into the queue so clean-queue can
      // trust it (a role flagged remote but tagged with an HQ city like "(San
      // Francisco)" IS remote — the city is just the company location).
      collected.push({ url, company: j.company, role: j.title, location: j.location, remote: !!j.remote, workplaceType: j.workplaceType || '', posted: j.posted || null, source: `api:${ats}`, persona: PERSONA, status: 'pending' });
    }
  };

  for (const ats of atsList) {
    if (collected.length >= MAX) break;
    const tokens = companies[ats].filter((t) => !DEFENSE_TOKENS.test(t) && !blockCompany(t));
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
