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

// Positive US signal — country and city names (case-insensitive).
const US_NAMES = /United States|\bUSA?\b|North America|Americas|New York|San Francisco|Austin|Seattle|Boston|Chicago|Denver|Atlanta|Los Angeles|Houston|Dallas|San Diego|Washington|Portland|Phoenix|Miami|Nashville|Raleigh|Charlotte|Salt Lake|Minneapolis|Philadelphia|Pittsburgh/i;
// Two-letter US state codes — CASE-SENSITIVE so the conjunction "or" doesn't
// match Oregon (OR), "in" doesn't match Indiana (IN), etc. Locations write
// state codes uppercase ("Houston, TX"; "Remote, US").
const US_CODES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
const US_STRONG = { test: (s) => US_NAMES.test(s) || US_CODES.test(s) };
// Location-agnostic remote markers with no country attached.
const REMOTE_ONLY = /^[\s,/\-|]*(remote|anywhere|worldwide|global|distributed)[\s,/\-|]*$/i;

// Defense / ITAR companies that require US citizenship or an active clearance —
// the persona is a green-card holder (usCitizen: No), so these always fail at
// submit. Skip them at discovery so they don't clog the queue.
const DEFENSE_TOKENS = /^(anduril|andurilindustries|shieldai|shield-ai|palantir|spacex|skydio|twosixtechnologies|two-six|kratos|raytheon|rtx|lockheed|northrop|boeing|generalatomics|ga-asi|saic|leidos|boozallen|mantech|caci|peraton|l3harris|hii|sierranevada|epirus|saronic|applied-intuition-defense|accenturefederalservices|cybersheath|ardentmc|gdit|generaldynamicsit|govini|rebellion-defense|rebelliondefense|parsons|battelle|mitre|miter|noblis|aerospace|in-q-tel|coreweave-gov|carahsoft|maximus|guidehouse|icf|deloittefederal)$/i;
// Government / federal / clearance roles — the applicant is not a government
// employee and holds no clearance, so exclude these by job title.
const GOV_TITLE = /\b(federal|government|public sector|govcloud|gov cloud|\bDoD\b|\bDOD\b|department of defense|clearance|cleared|secret|TS\/SCI|top secret|polygraph|intelligence community|\bIC\b|CMMC|ITAR|NIST 800|FISMA|civilian agency|warfighter|defense)\b/i;

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

// Texas markers (for hybrid-in-Texas eligibility).
const TEXAS = /\b(TX|Texas|Houston|Austin|Dallas|San Antonio|Fort Worth|Plano|Irving|Frisco)\b/;
// Non-US country markers — a remote role tied to one of these is NOT remote-US.
const FOREIGN = /\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bPune\b|\bHyderabad\b|\bChennai\b|\bDelhi\b|\bGurgaon\b|\bNoida\b|\bCanada\b|\bToronto\b|\bVancouver\b|\bOntario\b|\bLATAM\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bPeru\b|\bChile\b|\bUruguay\b|\bUkraine\b|\bPhilippines\b|\bSouth Africa\b|\bNigeria\b|\bKenya\b|\bEgypt\b|\bPakistan\b|\bIndonesia\b|\bVietnam\b|\bThailand\b|\bMalaysia\b|\bSingapore\b|\bGermany\b|\bBerlin\b|\bMunich\b|\bFrance\b|\bParis\b|\bSpain\b|\bMadrid\b|\bPortugal\b|\bLisbon\b|\bPoland\b|\bRomania\b|\bNetherlands\b|\bAmsterdam\b|\bIreland\b|\bDublin\b|\bUnited Kingdom\b|\bUK\b|\bLondon\b|\bEurope\b|\bEMEA\b|\bAPAC\b|\bAustralia\b|\bSydney\b|\bNew Zealand\b|\bJapan\b|\bTokyo\b|\bChina\b|\bShanghai\b|\bKorea\b|\bIsrael\b|\bTel Aviv\b/i;

// Bare remote markers with NO place named → assume US-eligible.
const REMOTE_BARE = /^[\s,/\-|()•]*(remote|remote[- ]?first|fully[- ]?remote|distributed|remote[- ]?us|us[- ]?remote)[\s,/\-|()•]*$/i;

// STRICT eligibility for this goal: REMOTE in the USA, or HYBRID in Texas.
// POSITIVE rule (a blocklist can't catch every foreign place):
//   remote-US = remote AND (explicit US signal OR bare "Remote" with no place)
//   hybrid-TX = hybrid AND a Texas location
// Onsite-anywhere, remote tied to any named non-US place, and hybrid-outside-TX → skip.
function locationEligible(loc, remoteFlag, workplaceType) {
  const L = (loc || '').trim();
  const wt = (workplaceType || '').toLowerCase();
  const isRemote = !!remoteFlag || wt === 'remote' || /\bremote\b/i.test(L);
  const isHybrid = wt === 'hybrid' || /\bhybrid\b/i.test(L);

  // Hybrid only in Texas (per this goal: "remote, hybrid in Texas").
  if (isHybrid && TEXAS.test(L) && !FOREIGN.test(L)) return true;
  if (isRemote) {
    if (US_STRONG.test(L) && !FOREIGN.test(L)) return true;   // remote + explicit US (no foreign tag)
    if (REMOTE_BARE.test(L) || !L) return true;               // just "Remote"/"US-Remote" → assume US
    return false;                                             // remote but names some non-US place
  }
  return false;                                               // onsite / hybrid-foreign / remote-foreign
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

  const HW_RE = /\b(firmware|hardware|electrical|mechanical|actuator|\bRF\b|photonics|wafer|thermal|hydraulic|manufacturing|robotics|silicon|FPGA|PCB|optical|battery|propulsion|flight|powertrain|supplier quality|process quality|design assurance|product quality)\b/i;
  const CONC = 20; // concurrent board fetches — the pool is now thousands of tokens

  const collect = (ats, jobs) => {
    for (const j of jobs) {
      if (collected.length >= MAX) break;
      if (!persona.matchKeywords.test(j.title)) continue;            // role fit
      if (HW_RE.test(j.title)) continue;                             // skip hardware/manufacturing "test technician" roles (remove if you target hardware)
      if (GOV_TITLE.test(j.title)) continue;                          // skip federal/government/clearance roles
      if (!locationEligible(j.location, j.remote, j.workplaceType)) continue; // remote-US or hybrid-TX only
      const url = (j.url || '').split('?')[0].split('#')[0];
      if (!url || seen.has(url) || known.has(url)) continue;         // dedupe
      known.add(url);
      collected.push({ url, company: j.company, role: j.title, location: j.location, source: `api:${ats}`, persona: PERSONA, status: 'pending' });
    }
  };

  for (const ats of atsList) {
    if (collected.length >= MAX) break;
    const tokens = companies[ats].filter((t) => !DEFENSE_TOKENS.test(t));
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
