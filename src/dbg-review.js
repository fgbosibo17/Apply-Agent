// Review gate: DRY-RUN fill a job (no submit) + dump text fields, flag essays in yes/no.
const path = require('path');
const { chromium } = require('playwright');
const { applyGreenhouse } = require('./ats/greenhouse');
const { applyAshby } = require('./ats/ashby');
const answers = require('./answers');
// The persona's own profile — was hardcoded to 'browser-profile-qapilot'.
const PROFILE = answers.browserProfile;
async function review(page, url) {
  console.log('\n==== ' + url + ' (' + answers.fullName + ') ====');
  process.env.DRY_RUN = '1';
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(1000);
    await (/ashbyhq/.test(url) ? applyAshby : applyGreenhouse)(page, { company: url.split('/')[3] }); } catch (e) { console.log('err', e.message); }
  for (const fr of page.frames()) {
    const fields = await fr.$$eval('input[type="text"],input[type="email"],input[type="tel"],input:not([type]),textarea', (els) => {
      const lab = (e) => { if (e.id) { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l && l.innerText.trim()) return l.innerText.trim(); } let p = e.parentElement; for (let i = 0; i < 6 && p; i++) { const l = p.querySelector('label,legend,[class*="label"]'); if (l && l.innerText && l.innerText.trim()) return l.innerText.trim(); p = p.parentElement; } return e.getAttribute('aria-label') || e.placeholder || ''; };
      return els.filter((e) => e.offsetParent !== null && e.value && e.getAttribute('role') !== 'combobox').map((e) => ({ tag: e.tagName, label: (lab(e) || '').replace(/\s+/g, ' ').slice(0, 65), val: e.value.replace(/\s+/g, ' ').slice(0, 80), len: e.value.length }));
    }).catch(() => []);
    for (const f of fields) { const yn = /^\s*(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should)\b/i.test(f.label); const essay = f.len > 30 && !/^https?:|^\+?\d|@/.test(f.val); console.log(`  [${f.tag}] "${f.label}" = "${f.val}"${yn && essay ? ' 🚩ESSAY-IN-YESNO' : ''}`); }
  }
}
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || (await ctx.newPage());
  for (const u of process.argv.slice(2)) await review(page, u);
  await ctx.close();
})().catch((e) => { console.error('fatal', e.message); process.exit(1); });
