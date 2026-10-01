// Shared discovery eligibility filters.
//
// Extracted verbatim from src/discover-api.js so that EVERY discovery surface
// (ATS sweep, community registry, feeds) applies the SAME role/location/recency
// rules. Duplicating these regexes per runner is how a new source quietly starts
// queueing jobs the persona is not eligible for — a defense role, a Bangalore
// "remote" listing, a six-month-old posting — so they live in one place.
//
// Every export is pure and reads its policy from env once at require time:
//   REMOTE_ONLY=1   hybrid roles are excluded too (remote only)
//   ALLOW_BIG=1     famous big-cos are allowed back in
//   RECENT_DAYS=N   drop postings older than N days (0 = no cutoff; default 60)
//   TITLE_FILTER=re extra title regex applied ON TOP of persona matchKeywords

const { isBigCompany, isAggregator, isPersonalExclude } = require('./company-filter');

const flag = (v) => /^(1|true|yes)$/i.test(v || '');

const REMOTE_ONLY_MODE = flag(process.env.REMOTE_ONLY);
const ALLOW_BIG = flag(process.env.ALLOW_BIG);
// Default 21 days, not 0.
//
// This used to default to "no cutoff", so unless a caller remembered RECENT_DAYS the
// queue accumulated postings of any age — one queue held a row 1021 days old. Three weeks
// is long enough that a genuinely open role is still caught (boards routinely re-surface
// and re-date active postings) and short enough that most of what is left is still live.
// RECENT_DAYS=0 still disables the cutoff for a deliberate deep sweep.
const RECENT_DAYS = parseInt(process.env.RECENT_DAYS === undefined ? '60' : (process.env.RECENT_DAYS || '0'), 10);
const RECENT_CUTOFF = RECENT_DAYS > 0 ? Date.now() - RECENT_DAYS * 86400000 : 0;
const TITLE_FILTER = process.env.TITLE_FILTER ? new RegExp(process.env.TITLE_FILTER, 'i') : null;

// "Small/medium businesses only — no big companies" (user request 2026-06-30).
// Drop job-board aggregators always; drop famous big-cos unless ALLOW_BIG=1.
const blockCompany = (c) => isPersonalExclude(c) || isAggregator(c) || (!ALLOW_BIG && isBigCompany(c));

// Positive US signal — country and city names (case-insensitive).
const US_NAMES = /United States|\bUSA?\b|North America|Americas|New York|San Francisco|Austin|Seattle|Boston|Chicago|Denver|Atlanta|Los Angeles|Houston|Dallas|San Diego|Washington|Portland|Phoenix|Miami|Nashville|Raleigh|Charlotte|Salt Lake|Minneapolis|Philadelphia|Pittsburgh/i;
// Two-letter US state codes — CASE-SENSITIVE so the conjunction "or" doesn't
// match Oregon (OR), "in" doesn't match Indiana (IN), etc. Locations write
// state codes uppercase ("Houston, TX"; "Remote, US").
const US_CODES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/;
const US_STRONG = { test: (s) => US_NAMES.test(s) || US_CODES.test(s) };

// Texas markers (for hybrid-in-Texas eligibility).
const TEXAS = /\b(TX|Texas|Houston|Austin|Dallas|San Antonio|Fort Worth|Plano|Irving|Frisco)\b/;
// Non-US country markers — a remote role tied to one of these is NOT remote-US.
const FOREIGN = /\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bPune\b|\bHyderabad\b|\bChennai\b|\bDelhi\b|\bGurgaon\b|\bNoida\b|\bCanada\b|\bToronto\b|\bVancouver\b|\bOntario\b|\bLATAM\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bPeru\b|\bChile\b|\bUruguay\b|\bUkraine\b|\bPhilippines\b|\bSouth Africa\b|\bNigeria\b|\bKenya\b|\bEgypt\b|\bPakistan\b|\bIndonesia\b|\bVietnam\b|\bThailand\b|\bMalaysia\b|\bSingapore\b|\bGermany\b|\bBerlin\b|\bMunich\b|\bFrance\b|\bParis\b|\bSpain\b|\bMadrid\b|\bPortugal\b|\bLisbon\b|\bPoland\b|\bRomania\b|\bNetherlands\b|\bAmsterdam\b|\bIreland\b|\bDublin\b|\bUnited Kingdom\b|\bUK\b|\bLondon\b|\bEurope\b|\bEMEA\b|\bAPAC\b|\bAustralia\b|\bSydney\b|\bNew Zealand\b|\bJapan\b|\bTokyo\b|\bChina\b|\bShanghai\b|\bKorea\b|\bIsrael\b|\bTel Aviv\b/i;
// Bare remote markers with NO place named → assume US-eligible.
const REMOTE_BARE = /^[\s,/\-|()•]*(remote|remote[- ]?first|fully[- ]?remote|distributed|remote[- ]?us|us[- ]?remote|anywhere|worldwide)[\s,/\-|()•]*$/i;

// Defense / ITAR companies that require US citizenship or an active clearance —
// the persona is a green-card holder (usCitizen: No), so these always fail at
// submit. Skip them at discovery so they don't clog the queue.
const DEFENSE_TOKENS = /^(anduril|andurilindustries|shieldai|shield-ai|palantir|spacex|skydio|twosixtechnologies|two-six|kratos|raytheon|rtx|lockheed|northrop|boeing|generalatomics|ga-asi|saic|leidos|boozallen|mantech|caci|peraton|l3harris|hii|sierranevada|epirus|saronic|applied-intuition-defense|accenturefederalservices|cybersheath|ardentmc|gdit|generaldynamicsit|govini|rebellion-defense|rebelliondefense|parsons|battelle|mitre|miter|noblis|aerospace|in-q-tel|coreweave-gov|carahsoft|maximus|guidehouse|icf|deloittefederal)$/i;
// Government / federal / clearance roles — the applicant is not a government
// employee and holds no clearance, so exclude these by job title.
const GOV_TITLE = /\b(federal|government|public sector|govcloud|gov cloud|\bDoD\b|\bDOD\b|department of defense|clearance|cleared|secret|TS\/SCI|top secret|polygraph|intelligence community|\bIC\b|CMMC|ITAR|NIST 800|FISMA|civilian agency|warfighter|defense)\b/i;
// qa persona only: hardware/physical "test" roles that match QA keywords but are
// not software QA.
const HARDWARE_TITLE = /\b(firmware|hardware|electrical|mechanical|actuator|\bRF\b|photonics|wafer|thermal|hydraulic|manufacturing|robotics|silicon|FPGA|PCB|optical|battery|propulsion|flight|powertrain|supplier quality|process quality|design assurance|product quality)\b/i;

// STRICT eligibility for this goal: REMOTE in the USA, or HYBRID in Texas.
// POSITIVE rule (a blocklist can't catch every foreign place):
//   remote-US = remote AND (explicit US signal OR bare "Remote" with no place)
//   hybrid-TX = hybrid AND a Texas location
// Onsite-anywhere, remote tied to any named non-US place, and hybrid-outside-TX → skip.
// `title` is optional but worth passing: boards routinely put the real geo in the
// title and leave the location field a bare "Remote" ("Senior Engineer - Remote
// Europe" @ "Remote"), which the location-only rule waves through.
function locationEligible(loc, remoteFlag, workplaceType, title = '') {
  const L = (loc || '').trim();
  const wt = (workplaceType || '').toLowerCase();
  const isRemote = !!remoteFlag || wt === 'remote' || /\bremote\b/i.test(L);
  const isHybrid = wt === 'hybrid' || /\bhybrid\b/i.test(L);

  // A title naming a non-US place beats a bare "Remote" location — unless the
  // location itself carries an explicit US signal (then the title is a market or
  // a second office, not the requirement).
  if (title && FOREIGN.test(title) && !US_STRONG.test(L)) return false;

  // "Only remote" mode: reject anything not remote (no hybrid, no onsite).
  if (REMOTE_ONLY_MODE && !isRemote) return false;

  // Hybrid only in Texas (per this goal: "remote, hybrid in Texas").
  if (isHybrid && TEXAS.test(L) && !FOREIGN.test(L)) return true;
  if (isRemote) {
    if (US_STRONG.test(L) && !FOREIGN.test(L)) return true;   // remote + explicit US (no foreign tag)
    if (REMOTE_BARE.test(L) || !L) return true;               // just "Remote"/"US-Remote" → assume US
    return false;                                             // remote but names some non-US place
  }
  return false;                                               // onsite / hybrid-foreign / remote-foreign
}

// Role fit for the active persona. `persona` is the object from src/answers.js.
function titleEligible(title, persona) {
  const t = title || '';
  // Salaried employment only - see NON_SALARIED_TITLE at the foot of this file.
  if (NON_SALARIED_TITLE.test(t)) return false;
  if (!persona.matchKeywords.test(t)) return false;              // role fit
  if (TITLE_FILTER && !TITLE_FILTER.test(t)) return false;       // focused title filter
  if (persona.persona === 'qa' && HARDWARE_TITLE.test(t)) return false; // qa: skip hardware "test" roles
  if (GOV_TITLE.test(t)) return false;                           // skip federal/clearance roles
  return true;
}

// Recency gate. A posting the source dated, older than the cutoff, is dropped.
//
// A posting the source gave NO date for is kept — but this is not the rare case the
// original comment assumed. Measured: 700 of 983 rows in one queue were undated, so 71%
// of that queue bypassed this filter. Dropping them all would empty the queue, so they
// are kept and verified on the page instead: src/util/freshness.js detects an expired
// posting after navigation and skips it cleanly rather than filling in a dead form.
//
// `undated()` exists so a caller can count them and report the size of that blind spot.
function recentEnough(posted) {
  if (!RECENT_CUTOFF || !posted) return true;
  return posted >= RECENT_CUTOFF;
}
const undated = (posted) => !posted;

// One call that answers "should this normalized job enter the queue?" — used by
// every runner that produces the { title, location, remote, workplaceType,
// posted, company } shape.
function jobEligible(job, persona) {
  const title = job.title || job.role;
  if (!titleEligible(title, persona)) return false;
  if (blockCompany(job.company)) return false;
  if (!locationEligible(job.location, job.remote, job.workplaceType, title)) return false;
  if (!recentEnough(job.posted)) return false;
  return true;
}

module.exports = {
  blockCompany, locationEligible, titleEligible, recentEnough, undated, jobEligible,
  RECENT_DAYS,
  DEFENSE_TOKENS, GOV_TITLE, HARDWARE_TITLE, TEXAS, FOREIGN, US_STRONG,
  REMOTE_ONLY_MODE, ALLOW_BIG, RECENT_CUTOFF, TITLE_FILTER,
};

// SALARIED EMPLOYMENT ONLY (2026-09-14, Fopes stated rule). A posting that pays
// commission only, engages a 1099 contractor, or is survey / mystery-shopper /
// franchise recruitment is not employment in the sense he means, whatever the
// title calls it. Company-level blocking catches the boards that are entirely
// this; this catches the individual posting on an otherwise legitimate board.
const NON_SALARIED_TITLE = /(commission[\s-]?only|100%\s*commission|uncapped commission|\b1099\b|independent contractor|self[\s-]?employed|own your own business|be your own boss|unpaid intern|volunteer|equity[\s-]?only|franchise|distributor|\bmlm\b|survey taker|paid survey|focus group|mystery shopper|product tester)/i;
