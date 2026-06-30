// Multi-board discovery via the LOGGED-IN cloud/persona profile.
// Scrapes the boards we're signed into (Builtin, Indeed) and extracts EXTERNAL
// company-ATS apply URLs (greenhouse/lever/ashby/workable/...) which our handlers
// can fill. Runs in the persona profile so logins are active.
//
//   PERSONA=primary node src/discover-boards.js
//
// Appends de-duped candidates to queue-<persona>.json. Honest about blocks:
// if a board shows a bot-check, it logs BLOCKED and moves on.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const answers = require('./answers');
const { personas } = require('./personas');

const PERSONA = (process.env.PERSONA || '').toLowerCase();
const persona = personas[PERSONA];
const QUEUE_FILE = path.resolve(__dirname, '..', `queue-${PERSONA}.json`);
const MAX_PER_BOARD = parseInt(process.env.MAX_PER_BOARD || '25', 10);

const QUERIES = (process.env.QUERIES ? process.env.QUERIES.split(',').map(s => s.trim()) : ({
  cloud: ['DevOps Engineer', 'Cloud Engineer', 'Site Reliability Engineer', 'Platform Engineer',
    'Infrastructure Engineer', 'Cloud Operations Engineer', 'Kubernetes Engineer', 'AWS Engineer',
    'Azure Engineer', 'Systems Engineer', 'Cloud Infrastructure Engineer', 'Reliability Engineer'],
  fullstack: ['Full Stack Engineer', 'Software Engineer', 'Backend Engineer', 'Frontend Engineer',
    'React Engineer', 'Node.js Engineer', 'JavaScript Engineer', 'Web Developer'],
  qa: ['SDET', 'QA Automation Engineer', 'Test Automation Engineer', 'Quality Engineer',
    'Senior SDET', 'QA Engineer', 'Automation Engineer', 'Software Engineer in Test'],
}[PERSONA] || ['DevOps Engineer']));

// External ATS URL patterns we have handlers for.
const ATS_RE = /(boards\.greenhouse\.io|job-boards\.greenhouse\.io)\/[^/]+\/jobs\/\d+|jobs\.lever\.co\/[^/]+\/[a-f0-9-]{20,}|jobs\.ashbyhq\.com\/[^/]+\/[a-f0-9-]{20,}|apply\.workable\.com\/[^/]+\/j\/[A-Z0-9]+/i;

const sleep = (p, ms) => p.waitForTimeout(ms);
const loadQueue = () => { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; } };

function detectBlock(text) {
  return /verify you are human|are you a robot|unusual traffic|access denied|cf-browser-verification|captcha|press & hold/i.test(text);
}

// ── Builtin ──────────────────────────────────────────────────────────────────
async function scrapeBuiltin(page, seen) {
  const found = [];
  for (const q of QUERIES) {
    const url = `https://builtin.com/jobs?search=${encodeURIComponent(q)}&daysSinceUpdated=7`;
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(page, 2500);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '');
    if (detectBlock(bodyText)) { console.log(`  [builtin] "${q}" — BLOCKED`); continue; }

    // Collect builtin job listing links
    const jobLinks = await page.evaluate(() => {
      const out = new Set();
      document.querySelectorAll('a[href*="/job/"]').forEach(a => { if (a.href.includes('builtin.com/job/')) out.add(a.href.split('?')[0]); });
      return Array.from(out).slice(0, 30);
    }).catch(() => []);

    let added = 0;
    for (const jl of jobLinks) {
      if (found.length >= MAX_PER_BOARD) break;
      // Open the builtin job page and look for an external ATS apply link
      await page.goto(jl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(page, 1500);
      const info = await page.evaluate(() => {
        const atsLink = Array.from(document.querySelectorAll('a')).map(a => a.href)
          .find(h => /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com/i.test(h));
        const title = document.querySelector('h1')?.innerText?.slice(0, 90) || '';
        const company = document.querySelector('[class*="company"], a[href*="/company/"]')?.innerText?.slice(0, 50) || '';
        return { atsLink, title, company };
      }).catch(() => ({}));
      if (info.atsLink && ATS_RE.test(info.atsLink)) {
        const clean = info.atsLink.split('?')[0].split('#')[0].replace(/\/(apply|application)\/?$/, '');
        if (!seen.has(clean)) {
          seen.add(clean);
          found.push({ url: clean, company: info.company || 'Unknown', role: info.title || q, source: 'builtin', persona: PERSONA, status: 'pending' });
          added++;
        }
      }
    }
    console.log(`  [builtin] "${q}" — ${jobLinks.length} listings → ${added} external-ATS`);
    if (found.length >= MAX_PER_BOARD) break;
  }
  return found;
}

// ── Indeed ───────────────────────────────────────────────────────────────────
async function scrapeIndeed(page, seen) {
  const found = [];
  for (const q of QUERIES) {
    const url = `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&l=Remote&fromage=7`;
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(page, 3000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1500)).catch(() => '');
    if (detectBlock(bodyText)) { console.log(`  [indeed] "${q}" — BLOCKED (bot check)`); continue; }

    const jks = await page.evaluate(() => {
      const out = new Set();
      document.querySelectorAll('a[data-jk], [data-jk]').forEach(e => { const jk = e.getAttribute('data-jk'); if (jk) out.add(jk); });
      return Array.from(out).slice(0, 20);
    }).catch(() => []);

    let added = 0;
    for (const jk of jks) {
      if (found.length >= MAX_PER_BOARD) break;
      await page.goto(`https://www.indeed.com/viewjob?jk=${jk}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(page, 1800);
      const info = await page.evaluate(() => {
        const atsLink = Array.from(document.querySelectorAll('a')).map(a => a.href)
          .find(h => /greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com/i.test(h));
        const title = document.querySelector('h1')?.innerText?.slice(0, 90) || '';
        return { atsLink, title };
      }).catch(() => ({}));
      if (info.atsLink && ATS_RE.test(info.atsLink)) {
        const clean = info.atsLink.split('?')[0].split('#')[0].replace(/\/(apply|application)\/?$/, '');
        if (!seen.has(clean)) {
          seen.add(clean);
          found.push({ url: clean, company: 'Unknown', role: info.title || q, source: 'indeed', persona: PERSONA, status: 'pending' });
          added++;
        }
      }
    }
    console.log(`  [indeed] "${q}" — ${jks.length} cards → ${added} external-ATS`);
    if (found.length >= MAX_PER_BOARD) break;
  }
  return found;
}

(async () => {
  if (!persona) { console.error('PERSONA required'); process.exit(1); }
  console.log(`\nMulti-board discovery — persona: ${PERSONA} (logged-in profile)`);
  console.log(`Boards: builtin, indeed | queries: ${QUERIES.join(', ')}\n`);

  const ctx = await chromium.launchPersistentContext(answers.browserProfile, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  const existing = loadQueue();
  const seen = new Set(existing.map(j => j.url));

  console.log('— Builtin —');
  const b = await scrapeBuiltin(page, seen);
  console.log('\n— Indeed —');
  const i = await scrapeIndeed(page, seen);

  const all = b.concat(i);
  const merged = existing.concat(all);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(merged, null, 2));
  console.log(`\nBuiltin: ${b.length} | Indeed: ${i.length} | total new: ${all.length}`);
  console.log(`Queue now ${merged.length}. Wrote ${QUEUE_FILE}`);

  await ctx.close();
  process.exit(0);
})();
