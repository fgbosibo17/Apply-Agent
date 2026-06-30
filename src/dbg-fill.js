// Dry-run fill test: open ATS URLs, run the REAL handler with DRY_RUN
// (fills everything, screenshots, does NOT submit). Reports unfilled required.
// Usage: PERSONA=primary DRY_RUN=1 node src/dbg-fill.js <url> [url2 ...]
const { chromium } = require('playwright');
const { applyGreenhouse } = require('./ats/greenhouse');
const { applyLever } = require('./ats/lever');
const { applyAshby } = require('./ats/ashby');
const { applyWorkable } = require('./ats/workable');
let applyCareerpuck, applySmartrecruiters;
try { applyCareerpuck = require('./ats/careerpuck').applyCareerpuck; } catch {}
try { applySmartrecruiters = require('./ats/smartrecruiters').applySmartrecruiters; } catch {}

function route(url) {
  if (/greenhouse\.io/i.test(url)) return ['greenhouse', applyGreenhouse];
  if (/careerpuck\.com/i.test(url)) return ['careerpuck', applyCareerpuck];
  if (/jobs\.lever\.co/i.test(url)) return ['lever', applyLever];
  if (/ashbyhq\.com/i.test(url)) return ['ashby', applyAshby];
  if (/workable\.com/i.test(url)) return ['workable', applyWorkable];
  if (/smartrecruiters\.com/i.test(url)) return ['smartrecruiters', applySmartrecruiters];
  return ['unknown', null];
}

(async () => {
  const urls = process.argv.slice(2);
  const ctx = await chromium.launchPersistentContext('./browser-profile-qa', {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  for (const url of urls) {
    const [ats, handler] = route(url);
    if (!handler) { console.log(`\n${url}\n  => no handler for ${ats}`); continue; }
    const company = (url.match(/\.(?:io|com|co)\/(?:[^/]*\/)?([^/]+)/) || [])[1] || ats;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await page.waitForTimeout(800);
      const r = await handler(page, { company });
      console.log(`\n[${ats}] ${company}\n  ${url}\n  => ${r.status}: ${r.reason}`);
    } catch (e) {
      console.log(`\n[${ats}] ${url}\n  => EXCEPTION: ${e.message}`);
    }
  }
  await ctx.close();
})();
