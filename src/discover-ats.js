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
// Google searching runs in the PERSONA's own profile rather than a throwaway
// 'browser-profile-discovery' dir. One profile per persona is the rule now, and
// a signed-in Google session actually gets challenged LESS than a cold one.
const DISCOVERY_PROFILE = answers.browserProfile;

// Persona → default query set (overridable via QUERIES env).
const DEFAULT_QUERIES = {
  cloud: ['DevOps Engineer', 'Cloud Engineer', 'Site Reliability Engineer', 'Platform Engineer', 'Infrastructure Engineer', 'Cloud Support Engineer', 'SRE', 'Cloud Operations'],
  fullstack: ['Full Stack Engineer', 'Software Engineer React', 'Backend Engineer Node', 'Frontend Engineer', 'Full Stack Developer', 'Software Engineer remote'],
  qa: ['SDET', 'QA Automation Engineer', 'Test Automation Engineer', 'Quality Engineer', 'Senior SDET', 'QA Architect'],
};

const QUERIES = (process.env.QUERIES ? process.env.QUERIES.split(',') : DEFAULT_QUERIES[PERSONA] || DEFAULT_QUERIES.cloud).map(s => s.trim());

// ATS domains + URL match patterns + how to clean each.
const ATS = [
  { name: 'greenhouse', q: 'site:job-boards.greenhouse.io', re: /greenhouse\.io\/[^/]+\/jobs\/\d+/i, clean: u => u.split('?')[0].split('#')[0] },
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

  // Search engine is selectable (Google hard-blocks automated queries). Bing and
  // especially DuckDuckGo's HTML endpoint tolerate scripted site: searches.
  const ENGINE = (process.env.SEARCH_ENGINE || 'google').toLowerCase();
  const isDDG = ENGINE === 'duckduckgo' || ENGINE === 'ddg';
  // Location hint appended to every query — default remote-US; set LOC=Texas (etc.)
  // to hunt hybrid-in-Texas roles (per the user's "then hybrid in Texas" scope).
  const LOC = process.env.LOC || 'remote US';
  const searchUrl = (atsQ, query, start) => {
    const q = `${atsQ} "${query}" ${LOC}`;
    if (ENGINE === 'bing') return `https://www.bing.com/search?q=${encodeURIComponent(q)}&count=30&first=${start + 1}`;
    if (isDDG) return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}${start ? `&s=${start}&dc=${start + 1}` : ''}`;
    return `https://www.google.com/search?q=${encodeURIComponent(q)}&num=30&start=${start}`;
  };
  // DuckDuckGo tolerates pagination — pull 3 result pages per query for ~3x supply.
  const PAGES = isDDG ? [0, 30, 60] : [0];

  for (const ats of ATS) {
    for (const query of QUERIES) {
      const reSrc = ats.re.source, reFlags = ats.re.flags;
      const urls = [];
      const seenHref = new Set();
      for (const start of PAGES) {
        await page.goto(searchUrl(ats.q, query, start), { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(page, 1500);
        const blocked = await page.evaluate(() => /unusual traffic|are you a robot|not a robot|please verify|captcha|blocked|enablejs/i.test(document.body.innerText.slice(0, 2000))).catch(() => false);
        if (blocked) { console.log(`  [${ats.name}] "${query}" p${start} — BLOCKED by ${ENGINE}, backing off 8s`); await sleep(page, 8000); break; }
        const pageUrls = await page.evaluate(({ reSrc, reFlags }) => {
          const re = new RegExp(reSrc, reFlags);
          // Resolve engine redirect wrappers to the real destination URL.
          const resolve = (href) => {
            try {
              const u = new URL(href, location.origin);
              if (/google\./.test(u.hostname) && u.searchParams.get('q')) return u.searchParams.get('q');
              if (u.searchParams.get('uddg')) return decodeURIComponent(u.searchParams.get('uddg')); // DuckDuckGo
              if (u.searchParams.get('u')) { // Bing ck/a
                let b = u.searchParams.get('u').replace(/^a1/, '').replace(/-/g, '+').replace(/_/g, '/');
                try { return atob(b); } catch { /* not base64 */ }
              }
              return href;
            } catch { return href; }
          };
          const out = [];
          document.querySelectorAll('a').forEach(a => {
            const real = resolve(a.href || '');
            if (re.test(real)) {
              const t = a.querySelector('h3');
              out.push({ href: real, title: t ? t.innerText : (a.innerText || '').split('\n')[0].slice(0, 90) });
            }
          });
          return out;
        }, { reSrc, reFlags }).catch(() => []);
        const fresh = pageUrls.filter(x => !seenHref.has(x.href));
        fresh.forEach(x => seenHref.add(x.href));
        urls.push(...fresh);
        if (!fresh.length) break; // page yielded nothing new → stop paginating this query
        await sleep(page, 800);
      }

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
