// BuiltIn (builtin.com) discovery — DOM scrape of the logged-in QA profile.
//
// BuiltIn is a DISCOVERY board: its /job/<slug>/<id> pages expose the company's
// EXTERNAL ATS apply URL directly as an <a target="_blank">APPLY link. We scrape
// the remote search results, visit each job page, extract that external URL, keep
// only ATSs our handlers can submit (greenhouse/lever/ashby/workable/
// smartrecruiters/careerpuck), filter by the QA persona's title keywords +
// big-co/personal excludes, dedupe, and append to queue-<persona>.json. The
// existing apply runner (src/index.js) then submits on the company ATS.
//
//   PERSONA=qa node src/discover-builtin.js            # default queries, remote
//   PERSONA=qa node src/discover-builtin.js --max 80
//
// Requires the persona's browser profile to be logged into builtin.com (it is,
// from setup). Headful real Chrome — a window opens.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { loadSeenUrls } = require('./log');
const { excludeCompany } = require('./util/company-filter');
const answers = require('./answers'); // throws if PERSONA unset

const PERSONA = answers.persona;
const PROFILE = process.env.BROWSER_PROFILE
  ? path.resolve(__dirname, '..', process.env.BROWSER_PROFILE)
  : answers.browserProfile;
const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);

const arg = (n, d) => { const e = process.argv.find((a) => a.startsWith(`--${n}=`)); if (e) return e.split('=')[1]; const i = process.argv.indexOf(`--${n}`); return (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) ? process.argv[i + 1] : d; };
const MAX = parseInt(arg('max', '80'), 10);
const PAGES = parseInt(arg('pages', '2'), 10);   // search-result pages per query
const QUERIES = (arg('queries', '') || 'QA automation,SDET,quality assurance,test automation,quality engineer,release manager,business analyst,implementation specialist,solutions engineer,data quality,LLM evaluation,technical support engineer').split(',').map((s) => s.trim()).filter(Boolean);

// Only these ATSs have working handlers in src/index.js.
const SUPPORTED = /boards\.greenhouse\.io|job-boards\.greenhouse\.io|greenhouse\.io\/embed|jobs\.lever\.co|jobs\.ashbyhq\.com|apply\.workable\.com|smartrecruiters\.com|careerpuck\.com/i;
const FOREIGN = /\bIndia\b|\bCanada\b|\bUnited Kingdom\b|\bLondon\b|\bEurope\b|\bEMEA\b|\bAPAC\b|\bLATAM\b|\bMexico\b|\bBrazil\b|\bGermany\b|\bAustralia\b/i;

function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; } }

// If a Cloudflare / bot-detection challenge is showing, PAUSE and wait for the
// user to clear it (they click it — the agent must not). Polls up to ~5 min.
async function waitIfChallenged(page) {
  for (let i = 0; i < 60; i++) {
    const challenged = await page.evaluate(() => /verify you are human|checking your browser|just a moment|needs to review the security|cf-challenge|cloudflare/i.test(document.body.innerText.slice(0, 1500)) || !!document.querySelector('iframe[src*="challenges.cloudflare"], #cf-challenge-running, .cf-turnstile')).catch(() => false);
    if (!challenged) return true;
    if (i === 0) console.log('\n⚠️  CLOUDFLARE CHALLENGE — please click "Verify you are human" in the browser window. Waiting for you (up to 5 min)...');
    await page.waitForTimeout(5000);
  }
  console.log('   still challenged after 5 min — moving on.');
  return false;
}

async function dismissCookies(page) {
  for (const label of ['Accept All Cookies', 'Accept all', 'Accept', 'I Accept', 'Got it', 'Agree']) {
    const b = await page.$(`button:has-text("${label}")`).catch(() => null);
    if (b && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(500); return; }
  }
}

async function collectSearch(page, query) {
  const urls = new Set();
  for (let pg = 1; pg <= PAGES; pg++) {
    const u = `https://builtin.com/jobs/remote?search=${encodeURIComponent(query)}${pg > 1 ? `&page=${pg}` : ''}`;
    await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await waitIfChallenged(page);
    if (pg === 1) await dismissCookies(page);
    const links = await page.$$eval('a[href*="/job/"]', (as) => as.map((a) => ({ href: a.href.split('?')[0], text: (a.innerText || '').trim() }))).catch(() => []);
    let added = 0;
    for (const l of links) { if (/\/job\/[^/]+\/\d+/.test(l.href) && l.text) { if (!urls.has(l.href)) added++; urls.add(l.href); } }
    if (!added) break; // no more results
  }
  return [...urls];
}

// Visit a BuiltIn job page → { title, company, externalUrl }
async function resolveJob(page, jobUrl) {
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await waitIfChallenged(page);
  return page.evaluate(() => {
    const applyA = [...document.querySelectorAll('a')].find((a) => /apply/i.test(a.innerText || a.getAttribute('aria-label') || '') && a.href && !/builtin\.com/i.test(a.href));
    const title = (document.querySelector('h1') || {}).innerText || document.title.split('|')[0] || '';
    // company: title tail "... - <Company> | Built In", or a company link
    const m = document.title.match(/-\s*([^|]+?)\s*\|\s*Built In/i);
    const company = (m && m[1].trim()) || '';
    const loc = (document.body.innerText.match(/\b(Remote|Hybrid|On-?site)\b[^\n]{0,40}/i) || [''])[0];
    return { title: (title || '').trim().slice(0, 120), company: company.slice(0, 60), externalUrl: applyA ? applyA.href : '', loc: loc.slice(0, 60) };
  }).catch(() => ({ title: '', company: '', externalUrl: '' }));
}

async function main() {
  const seen = loadSeenUrls();
  const existing = loadQueue();
  const known = new Set(existing.map((j) => (j.url || '').split('?')[0].split('#')[0]));
  const matchKeywords = answers.matchKeywords || require('./personas').personas[PERSONA].matchKeywords;

  console.log(`\nBuiltIn discovery — persona ${PERSONA} (${answers.fullName})`);
  console.log(`Queries: ${QUERIES.join(' | ')}`);
  console.log(`Target: up to ${MAX} new applyable candidates\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const collected = [];
  const jobPage = await ctx.newPage();
  // Write incrementally so a kill/timeout never loses collected jobs (each job
  // page visit is slow — the run can outlast a foreground timeout).
  const saveQueue = () => { try { fs.writeFileSync(QUEUE_FILE, JSON.stringify(existing.concat(collected), null, 2)); } catch {} };

  try {
    for (const q of QUERIES) {
      if (collected.length >= MAX) break;
      const jobUrls = await collectSearch(page, q);
      console.log(`  "${q}": ${jobUrls.length} cards`);
      for (const ju of jobUrls) {
        if (collected.length >= MAX) break;
        const r = await resolveJob(jobPage, ju);
        if (!r.title || !matchKeywords.test(r.title)) continue;             // QA title fit
        if (!r.externalUrl || !SUPPORTED.test(r.externalUrl)) continue;     // handler-supported ATS only
        const ext = r.externalUrl.split('?')[0].split('#')[0];
        if (seen.has(ext) || known.has(ext)) continue;                       // dedupe
        if (excludeCompany(r.company)) continue;                             // big-co / juniper / akuity
        if (FOREIGN.test(r.loc) && !/remote/i.test(r.loc)) continue;
        known.add(ext);
        collected.push({ url: ext, company: r.company || 'unknown', role: r.title, location: r.loc || 'Remote', remote: /remote/i.test(r.loc), source: 'builtin', persona: PERSONA, status: 'pending' });
        saveQueue(); // persist after every job
        console.log(`    + ${r.company} — ${r.title}  [${ext.replace(/^https?:\/\//, '').split('/')[0]}]`);
      }
    }
  } finally {
    await ctx.close().catch(() => {});
  }

  const merged = existing.concat(collected);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(merged, null, 2));
  console.log(`\nCollected ${collected.length} new BuiltIn candidates (queue now ${merged.length}). Wrote ${QUEUE_FILE}`);
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
