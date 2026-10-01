// Workday discovery: sweep the public CXS job-search API of named Workday tenants.
//
// WHY THIS EXISTS. discover-api.js sweeps five ATSs that publish an open board
// API keyed by a company token. Many large employers are on none of them: they
// run Workday, which has no token catalogue and no board index. So every one of
// those companies is silently unreachable: not filtered out, just never looked
// at. This module closes that gap for the tenants you have CONFIRMED by probe,
// listed in data/workday-boards.json (empty in the template — add your own).
//
//   PERSONA=primary node src/discover-workday.js
//   PERSONA=primary node src/discover-workday.js --max 200
//
// Rows are written into queue-<persona>.json in exactly the shape
// discover-api.js emits, and pass through the SAME eligibility module, so a job
// this source queues is one the other source would also have queued. That
// sharing is deliberate: an employer the user blocked must stay blocked no
// matter which discovery surface found the posting.

const path = require('path');
const fs = require('fs');
const { loadSeenUrls } = require('./log');
const answers = require('./answers'); // throws if PERSONA unset -- intentional
const {
  blockCompany, locationEligible, titleEligible, DEFENSE_TOKENS,
} = require('./util/eligibility');

const PERSONA = answers.persona;
// A board in workday-boards.json is there because the user named that
// employer. That naming is exactly what the big-company and aggregator filters
// are meant to defer to, so they do not run here - only the two rules that no
// naming overrides: the personal blocklist, and salaried employment only.
const { isPersonalExclude, isNonSalaried } = require(`./util/company-filter`);
const BOARDS_FILE = path.resolve(__dirname, '..', 'data', 'workday-boards.json');
const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);

function arg(name, def) {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return def;
}
const MAX = parseInt(arg('max', '200'), 10);
const PAGE = 20;                 // Workday caps the CXS page size at 20
const PAGE_CAP = parseInt(arg('pages', '25'), 10); // per board, so one huge tenant cannot eat the whole run

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

// Workday reports location as free text ('Remote, USA', 'US-Remote', 'Draper,
// UT'). There is no structured remote flag on the search payload, so the text
// is all we have -- and we only mark remote when it SAYS remote, never by
// inference, because a wrong remote flag is what puts an on-site job in a
// remote-only queue.
const REMOTE_TEXT = /\b(remote|work[\s-]?from[\s-]?home|wfh|virtual|home[\s-]?based|telecommute|anywhere)\b/i;

// ---------------------------------------------------------------------------
// Workday location text needs two repairs before the shared eligibility module
// can read it, and BOTH were silently costing us every single match.
//
// 1. Workday writes locations with underscores: US_Remote, US_Hicksville
//    NY_Office, IN_Mumbai_Virtual. An underscore is a word character, so
//    /\bremote\b/ does NOT match US_Remote -- the most obviously remote US
//    postings on the board were being read as neither remote nor US.
// 2. When a posting spans several locations Workday replaces the text with a
//    count -- 29 Locations -- which names no place at all. Those aggregates are
//    exactly the work-from-home roles this persona wants, so the real list is
//    fetched from the posting own endpoint instead of being thrown away.
//
// A STATE NAME IS NOT A COUNTRY. locationEligible needs an explicit US marker,
// and Work from Home Alabama has none, so a spelled-out US state name gets the
// country appended -- never the two-letter code, since IN is India on this very
// board. That is naming a fact about Alabama, not guessing at the posting.
const US_STATES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i;
const HAS_COUNTRY = /\b(us|usa|u\.s\.|united states)\b/i;
const AGGREGATE = /^\s*\d+\s+locations?\s*$/i;

function normalizeLocation(raw) {
  let s = String(raw || '').replace(/_/g, ', ').replace(/\s*,\s*/g, ', ').trim();
  if (s && US_STATES.test(s) && !HAS_COUNTRY.test(s)) s += ', USA';
  return s;
}

// One extra request, only for postings whose location text is a bare count.
async function resolveLocations(board, externalPath) {
  try {
    const u = `https://${board.tenant}.wd${board.wd}.myworkdayjobs.com/wday/cxs/${board.tenant}/${board.site}${externalPath}`;
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const info = ((await r.json()) || {}).jobPostingInfo || {};
    return [info.location].concat(info.additionalLocations || []).filter(Boolean);
  } catch (e) { return []; }
}

async function fetchPage(board, offset) {
  const url = `https://${board.tenant}.wd${board.wd}.myworkdayjobs.com/wday/cxs/${board.tenant}/${board.site}/jobs`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText: '' }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  if (!fs.existsSync(BOARDS_FILE)) {
    console.error(`no ${BOARDS_FILE} -- nothing to sweep`);
    process.exit(0);
  }
  const cfg = JSON.parse(fs.readFileSync(BOARDS_FILE, 'utf8'));
  const boards = (cfg.boards || []).filter((b) => {
    if (b.disabled) return false;
    if (Array.isArray(b.personas) && b.personas.length && !b.personas.includes(PERSONA)) return false;
    return true;
  });

  const queue = loadQueue();
  const known = new Set(queue.map((j) => j.url));
  const seen = loadSeenUrls();
  const collected = [];
  const stats = [];

  for (const board of boards) {
    if (collected.length >= MAX) break;
    const name = board.company || board.tenant;

    // The blocklist is checked HERE, before a single request goes out, and again
    // per row below. Cheap, and it means a blocked employer never even sees our
    // traffic.
    if (DEFENSE_TOKENS.test(board.tenant) || isPersonalExclude(name) || isNonSalaried(name)) {
      stats.push(`${name}: skipped (blocked)`);
      continue;
    }

    let taken = 0; let scanned = 0; let total = null; let err = null;
    for (let page = 0; page < PAGE_CAP; page += 1) {
      if (collected.length >= MAX) break;
      let data;
      try {
        data = await fetchPage(board, page * PAGE);
      } catch (e) { err = String(e.message || e); break; }
      if (total === null) total = data.total;
      const rows = data.jobPostings || [];
      if (!rows.length) break;
      for (const p of rows) {
        scanned += 1;
        const title = p.title || '';
        let location = normalizeLocation(p.locationsText);
        if (!titleEligible(title, answers)) continue;
        // Resolved AFTER the title gate so only rows worth keeping pay for the
        // extra request. A count is not a place; the posting knows the real list.
        if (AGGREGATE.test(p.locationsText || '')) {
          const real = await resolveLocations(board, p.externalPath || '');
          if (real.length) location = real.slice(0, 8).map(normalizeLocation).join('; ');
        }
        // Remote is decided BEFORE the location gate, because locationEligible
        // needs the flag to tell a remote posting tagged with an HQ city from a
        // genuinely on-site one.
        const remote = REMOTE_TEXT.test(location) || REMOTE_TEXT.test(title);
        const workplaceType = remote ? 'remote' : '';
        if (!locationEligible(location, remote, workplaceType, title)) continue;
        const url = `https://${board.tenant}.wd${board.wd}.myworkdayjobs.com/en-US/${board.site}${p.externalPath || ''}`;
        if (!p.externalPath || seen.has(url) || known.has(url)) continue;
        known.add(url);
        collected.push({
          url,
          company: name,
          role: title,
          location,
          remote,
          workplaceType,
          // Workday search payloads date a posting only as relative prose
          // ('Posted 30+ Days Ago'), which is not a date. Rather than parse
          // prose into a false precision, we record no date and flag the gap --
          // the same contract discover-api.js uses for undated rows.
          posted: null,
          postedUnknown: true,
          discoveredAt: new Date().toISOString(),
          source: `workday:${board.tenant}`,
          persona: PERSONA,
          status: 'pending',
        });
        taken += 1;
        if (collected.length >= MAX) break;
      }
      if (total !== null && (page + 1) * PAGE >= total) break;
    }
    stats.push(`${name}: ${taken} queued / ${scanned} scanned / ${total === null ? '?' : total} posted${err ? ` (stopped: ${err})` : ''}`);
  }

  for (const line of stats) console.log('    ' + line);
  if (!collected.length) {
    console.log('Collected 0 new candidates (queue unchanged).');
    return;
  }
  const merged = queue.concat(collected);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(merged, null, 2));
  console.log(`Collected ${collected.length} new candidates (queue now ${merged.length}).`);
  console.log(`Wrote ${QUEUE_FILE}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
