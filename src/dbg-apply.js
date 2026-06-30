// DRY-RUN a single application through the real handler (no submit). Verifies
// fill quality (EEO radios, screening answers) via a full-page screenshot.
// Usage: PERSONA=cloud DRY_RUN=1 node src/dbg-apply.js <url> [company]
const { chromium } = require('playwright');
const { applyGreenhouse } = require('./ats/greenhouse');
const { applyAshby } = require('./ats/ashby');
const { applyLever } = require('./ats/lever');
const { applyWorkable } = require('./ats/workable');
const { applySmartrecruiters } = require('./ats/smartrecruiters');
const answers = require('./answers');

const URL = process.argv[2];
const COMPANY = process.argv[3] || 'dbg';
if (!URL) { console.error('pass a url'); process.exit(1); }

function detectAts(url) {
  if (/greenhouse\.io/i.test(url)) return 'greenhouse';
  if (/ashbyhq\.com/i.test(url)) return 'ashby';
  if (/lever\.co/i.test(url)) return 'lever';
  if (/workable\.com/i.test(url)) return 'workable';
  if (/smartrecruiters\.com/i.test(url)) return 'smartrecruiters';
  return 'greenhouse';
}

(async () => {
  process.env.DRY_RUN = process.env.DRY_RUN || '1';
  const ctx = await chromium.launchPersistentContext(answers.browserProfile, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const ats = detectAts(URL);
  console.log('Persona:', answers.persona, '| ATS:', ats, '| URL:', URL);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const handler = { greenhouse: applyGreenhouse, ashby: applyAshby, lever: applyLever, workable: applyWorkable, smartrecruiters: applySmartrecruiters }[ats];
  const r = await handler(page, { url: URL, company: COMPANY }).catch((e) => ({ status: 'Error', reason: e.message }));
  console.log('RESULT:', JSON.stringify(r));

  // Dump the state of every radio group + select so we can verify EEO etc.
  const form = (() => { for (const f of page.frames()) if (/greenhouse\.io.*job_app|grnhse|ashby|lever|workable/i.test(f.url())) return f; return page; })();
  const report = await form.evaluate(() => {
    const out = { radios: [], selects: [] };
    const groups = {};
    document.querySelectorAll('input[type="radio"]').forEach((r) => { (groups[r.name] = groups[r.name] || []).push(r); });
    for (const name of Object.keys(groups)) {
      const g = groups[name];
      const checked = g.find((r) => r.checked);
      const qlabel = (() => { let p = g[0].parentElement; for (let i = 0; i < 8 && p; i++) { const lg = p.querySelector('legend,.application-label,h3,label'); if (lg && lg.innerText.trim() && !/^(yes|no)\b/i.test(lg.innerText.trim())) return lg.innerText.trim().slice(0, 70); p = p.parentElement; } return name; })();
      const lblOf = (r) => { const l = (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)) || r.closest('label'); return (l && l.innerText.trim()) || r.value; };
      out.radios.push({ q: qlabel, chosen: checked ? lblOf(checked).slice(0, 50) : '*** NONE ***' });
    }
    document.querySelectorAll('select').forEach((s) => {
      if (s.offsetParent === null) return;
      const lbl = (s.closest('div,fieldset')?.querySelector('label')?.innerText || '').slice(0, 50);
      out.selects.push({ q: lbl, val: s.options[s.selectedIndex]?.text?.slice(0, 40) || '' });
    });
    out.combos = [];
    document.querySelectorAll('input[role="combobox"]').forEach((c) => {
      const ctrl = c.closest('.select__control') || c.closest('[class*="select__control"]');
      let val = ctrl && ctrl.querySelector('.select__single-value, [class*="single-value"]');
      let valText = val ? val.innerText.slice(0, 40) : '';
      if (!valText && ctrl) { const t = (ctrl.innerText || '').replace(/\s+/g, ' ').trim(); if (t && !/^select\b|^select…|^choose\b|^- *select/i.test(t) && t.length < 80) valText = t.slice(0, 40); }
      // label via label[for=id]
      let q = c.id ? (document.querySelector(`label[for="${c.id.replace(/"/g, '\\"')}"]`)?.innerText || '').trim().slice(0, 50) : '';
      if (!q) { let p = c.parentElement; for (let i = 0; i < 6 && p; i++) { const t = (p.querySelector('label')?.innerText || '').trim(); if (t) { q = t.slice(0, 50); break; } p = p.parentElement; } }
      out.combos.push({ q, val: valText || '*** EMPTY ***' });
    });
    return out;
  }).catch(() => ({ radios: [], selects: [] }));
  console.log('\n=== RADIO GROUPS ===');
  for (const r of report.radios) console.log(`  [${r.chosen}]  <- ${r.q}`);
  console.log('\n=== SELECTS ===');
  for (const s of report.selects) console.log(`  [${s.val}]  <- ${s.q}`);
  console.log('\n=== COMBOBOXES (react-select) ===');
  for (const c of (report.combos || [])) console.log(`  [${c.val}]  <- ${c.q}`);

  await page.screenshot({ path: `dryrun-${COMPANY}.png`, fullPage: true }).catch(() => {});
  console.log(`\nScreenshot: dryrun-${COMPANY}.png`);
  await ctx.close();
})();
