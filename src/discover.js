// Discovery via logged-in job boards (primary: LinkedIn).
// Runs INSIDE the persona's browser profile so the board logins are active —
// logged-in LinkedIn returns far better, fresher, better-matched listings.
//
//   PERSONA=primary node src/discover.js
//   PERSONA=primary node src/discover.js --max 60
//
// Output: appends de-duped candidates to queue.json (source-tagged) so the
// apply runner (src/index.js) can process them. LinkedIn entries keep their
// /jobs/view/<id> URL; the runner resolves the external ATS link at apply time.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const answers = require('./answers'); // throws if PERSONA unset
const { personas } = require('./personas');

const PERSONA = (process.env.PERSONA || '').toLowerCase();
const persona = personas[PERSONA];
const MAX = parseInt((process.argv.find(a => a.startsWith('--max='))?.split('=')[1]) ||
  (process.argv[process.argv.indexOf('--max') + 1]) || '60', 10);

const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);
const PROFILE_DIR = answers.browserProfile;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

async function searchLinkedIn(page, keyword) {
  // f_WT=2 → Remote, f_TPR=r604800 → past 7 days, US location
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}` +
    `&f_WT=2&f_TPR=r604800&location=United%20States&geoId=103644278`;
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(3000);

  // Confirm we're logged in (logged-out shows /authwall or a join modal)
  if (/authwall|\/login|\/signup/i.test(page.url())) {
    return { loggedIn: false, jobs: [] };
  }

  // Scroll the results list to load more cards
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      const list = document.querySelector('.scaffold-layout__list-container') ||
                   document.querySelector('ul.jobs-search__results-list') ||
                   document.querySelector('[data-results-list-top-scroll-sentinel]')?.parentElement;
      if (list) list.scrollBy(0, 1500);
      else window.scrollBy(0, 1500);
    }).catch(() => {});
    await sleep(1200);
  }

  const jobs = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('a[href*="/jobs/view/"]').forEach(a => {
      const m = (a.href || '').match(/\/jobs\/view\/(\d+)/);
      if (!m) return;
      const id = m[1];
      if (seen.has(id)) return;
      seen.add(id);
      // Walk up to the card to grab title/company/location
      let card = a;
      for (let i = 0; i < 6 && card; i++) {
        if (card.matches?.('li, div.job-card-container, .job-card-container')) break;
        card = card.parentElement;
      }
      const txt = (sel) => card?.querySelector(sel)?.innerText?.trim() || '';
      const title = a.innerText.trim().split('\n')[0] ||
                    txt('.job-card-list__title') || txt('[class*="job-card-list__title"]');
      const company = txt('.job-card-container__primary-description') ||
                      txt('.artdeco-entity-lockup__subtitle') ||
                      txt('[class*="subtitle"]');
      const location = txt('.job-card-container__metadata-item') ||
                       txt('[class*="metadata"]');
      out.push({ id, url: `https://www.linkedin.com/jobs/view/${id}/`, title, company, location });
    });
    return out;
  }).catch(() => []);

  return { loggedIn: true, jobs };
}

(async () => {
  if (!persona) { console.error('PERSONA must be qa|cloud|fullstack'); process.exit(1); }
  console.log(`\nDiscovery — persona: ${PERSONA} (${persona.fullName})`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Target: up to ${MAX} candidates\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const existing = loadQueue();
  const existingIds = new Set(existing.map(j => j.url));
  const collected = [];

  for (const role of persona.targetRoles) {
    if (collected.length >= MAX) break;
    process.stdout.write(`  LinkedIn: "${role}" ... `);
    const { loggedIn, jobs } = await searchLinkedIn(page, role);
    if (!loggedIn) {
      console.log('NOT LOGGED IN — stop and re-run setup-browser-login.js');
      break;
    }
    // Filter by persona keywords + remote/US sanity, dedupe
    let added = 0;
    for (const j of jobs) {
      const blob = `${j.title} ${j.company} ${j.location}`;
      if (!persona.matchKeywords.test(blob)) continue;
      if (existingIds.has(j.url)) continue;
      existingIds.add(j.url);
      collected.push({
        url: j.url, company: j.company || 'Unknown', role: j.title || role,
        source: 'linkedin', persona: PERSONA, status: 'pending',
      });
      added++;
      if (collected.length >= MAX) break;
    }
    console.log(`${jobs.length} cards → ${added} new`);
    await sleep(1500);
  }

  const merged = existing.concat(collected);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(merged, null, 2));
  console.log(`\nCollected ${collected.length} new candidates. Queue now has ${merged.length}.`);
  console.log(`Wrote ${QUEUE_FILE}`);

  await ctx.close();
  process.exit(0);
})();
