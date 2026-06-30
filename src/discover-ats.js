// Aggressive bulk ATS discovery via Google site: searches.
// Loops MANY (ATS domain × query) combos, extracts direct company-ATS job URLs,
// and appends de-duped candidates to a per-persona queue. No login needed, runs in
// a throwaway profile so it never conflicts with the apply batch's cloud profile.
//
//   PERSONA=cloud node src/discover-ats.js
//   PERSONA=cloud QUERIES="DevOps,Cloud Engineer,SRE" node src/discover-ats.js
//
// Queue file: queue-<persona>.json (candidates appended, deduped by URL).

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const answers = require('./answers'); // throws if PERSONA unset

const PERSONA = (process.env.PERSONA || '').toLowerCase();
const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);
const DISCOVERY_PROFILE = path.resolve(__dirname, '..', 'browser-profile-discovery');

// Persona → default query set (overridable via QUERIES env).
const DEFAULT_QUERIES = {
  cloud: ['DevOps Engineer', 'Cloud Engineer', 'Site Reliability Engineer', 'Platform Engineer', 'Infrastructure Engineer', 'Cloud Support Engineer', 'SRE', 'Cloud Operations'],
  fullstack: ['Full Stack Engineer', 'Software Engineer React', 'Backend Engineer Node', 'Frontend Engineer', 'Full Stack Developer', 'Software Engineer remote'],
  qa: ['SDET', 'QA Automation Engineer', 'Test Automation Engineer', 'Quality Engineer', 'Senior SDET', 'QA Architect'],
};

const QUERIES = (process.env.QUERIES ? process.env.QUERIES.split(',') : DEFAULT_QUERIES[PERSONA] || DEFAULT_QUERIES.cloud).map(s => s.trim());

// ATS domains + URL match patterns + how to clean each.
const ATS = [
  { name: 'greenhouse', q: '(site:boards.greenhouse.io OR site:job-boards.greenhouse.io)', re: /greenhouse\.io\/[^/]+\/jobs\/\d+/i, clean: u => u.split('?')[0].split('#')[0] },
  { name: 'lever', q: 'site:jobs.lever.co', re: /jobs\.lever\.co\/[^/]+\/[a-f0-9-]{20,}/i, clean: u => u.split('?')[0].split('#')[0].replace(/\/apply$/, '') },
  { name: 'ashby', q: 'site:jobs.ashbyhq.com', re: /jobs\.ashbyhq\.com\/[^/]+\/[a-f0-9-]{20,}/i, clean: u => u.split('?')[0].split('#')[0].replace(/\/application$/, '') },
  { name: 'workable', q: 'site:apply.workable.com', re: /apply\.workable\.com\/[^/]+\/j\/[A-Z0-9]+/i, clean: u => u.split('?')[0].split('#')[0].replace(/\/apply\/?$/, '') },
];

const sleep = (p, ms) => p.waitForTimeout(ms);

function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

function companyFromUrl(url) {
  const m = url.match(/greenhouse\.io\/([^/]+)\//) || url.match(/lever\.co\/([^/]+)\//) ||
            url.match(/ashbyhq\.com\/([^/]+)\//) || url.match(/workable\.com\/([^/]+)\//);
  return m ? m[1].replace(/[-_.]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unknown';
}

(async () => {
  if (!PERSONA) { console.error('PERSONA required'); process.exit(1); }
  console.log(`\nBulk ATS discovery — persona: ${PERSONA}`);
  console.log(`Queries (${QUERIES.length}): ${QUERIES.join(', ')}`);
  console.log(`ATS platforms: ${ATS.map(a => a.name).join(', ')}\n`);

  const ctx = await chromium.launchPersistentContext(DISCOVERY_PROFILE, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const existing = loadQueue();
  const seen = new Set(existing.map(j => j.url));
  const found = [];

  for (const ats of ATS) {
    for (const query of QUERIES) {
      const g = `https://www.google.com/search?q=${encodeURIComponent(`${ats.q} "${query}" remote US`)}&num=30`;
      await page.goto(g, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(page, 1500);

      // Captcha / block detection
      const blocked = await page.evaluate(() => /unusual traffic|not a robot|enablejs/i.test(document.body.innerText)).catch(() => false);
      if (blocked) { console.log(`  [${ats.name}] "${query}" — BLOCKED by Google, backing off 8s`); await sleep(page, 8000); continue; }

      const reSrc = ats.re.source, reFlags = ats.re.flags;
      const urls = await page.evaluate(({ reSrc, reFlags }) => {
        const re = new RegExp(reSrc, reFlags);
        const out = [];
        document.querySelectorAll('a').forEach(a => {
          const href = a.href || '';
          if (re.test(href)) {
            const t = a.querySelector('h3');
            out.push({ href, title: t ? t.innerText : a.innerText.split('\n')[0].slice(0, 90) });
          }
        });
        return out;
      }, { reSrc, reFlags }).catch(() => []);

      let added = 0;
      for (const { href, title } of urls) {
        const clean = ats.clean(href).replace(/^http:/, 'https:');
        if (seen.has(clean)) continue;
        seen.add(clean);
        found.push({ url: clean, company: companyFromUrl(clean), role: title || query, source: `google-${ats.name}`, persona: PERSONA, status: 'pending' });
        added++;
      }
      console.log(`  [${ats.name}] "${query}" — ${urls.length} hits → ${added} new (total ${found.length})`);
      await sleep(page, 1200);
    }
  }

  const merged = existing.concat(found);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(merged, null, 2));
  console.log(`\nAdded ${found.length} new candidates. Queue now ${merged.length}.`);
  await ctx.close();
  process.exit(0);
})();
