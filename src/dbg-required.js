// Run the real handler (DRY) then report every still-EMPTY required field, so we
// can see exactly what isn't filling. Usage: PERSONA=cloud node src/dbg-required.js <url>
const { chromium } = require('playwright');
const answers = require('./answers');
const { applyGreenhouse } = require('./ats/greenhouse');
const URL = process.argv[2];

(async () => {
  process.env.DRY_RUN = '1';
  const ctx = await chromium.launchPersistentContext(answers.browserProfile, { headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(800);
  const r = await applyGreenhouse(page, { url: URL, company: 'dbg', role: 'Solutions Engineer' });
  console.log('RESULT:', JSON.stringify(r));
  const empty = await page.evaluate(() => {
    const out = [];
    const labOf = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${el.id.replace(/"/g, '\\"')}"]`); if (l && l.innerText.trim()) return l.innerText.trim(); }
      let p = el.parentElement; for (let i = 0; i < 7 && p; i++) { const l = p.querySelector('label,legend'); if (l && l.innerText.trim()) return l.innerText.trim(); p = p.parentElement; }
      return el.getAttribute('aria-label') || el.name || el.id || '?';
    };
    const isReq = (el) => el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(labOf(el));
    // text inputs + textareas
    document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input:not([type]),textarea').forEach((el) => {
      if (el.offsetParent === null || el.getAttribute('role') === 'combobox') return;
      if (!isReq(el)) return;
      if ((el.value || '').trim()) return;
      out.push((el.tagName === 'TEXTAREA' ? 'TEXTAREA' : 'TEXT') + ' :: ' + labOf(el).slice(0, 70));
    });
    // comboboxes (react-select) without a value
    document.querySelectorAll('input[role="combobox"]').forEach((el) => {
      if (el.offsetParent === null) return;
      const c = el.closest('[class*="select__control"]');
      const has = c && (c.querySelector('[class*="single-value"]') || (() => { const t = (c.innerText || '').replace(/\s+/g, ' ').trim(); return t && !/^select|^choose|^- *select/i.test(t) && t.length < 80; })());
      if (has) return;
      if (!isReq(el)) return;
      out.push('COMBO :: ' + labOf(el).slice(0, 70));
    });
    // native selects
    document.querySelectorAll('select').forEach((el) => {
      if (el.offsetParent === null) return;
      if (!isReq(el)) return;
      const v = el.options[el.selectedIndex]?.text || '';
      if (v && !/^select|^choose|^- *select|^$/i.test(v)) return;
      out.push('SELECT :: ' + labOf(el).slice(0, 70));
    });
    return out;
  }).catch((e) => ['(eval error) ' + e.message]);
  console.log('STILL-EMPTY REQUIRED FIELDS:');
  if (!empty.length) console.log('  (none — all required filled)');
  for (const f of empty) console.log('  ' + f);
  await ctx.close();
})();
