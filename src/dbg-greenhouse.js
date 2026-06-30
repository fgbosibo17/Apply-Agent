// Debug probe: open a Greenhouse job, fetch its schema, and report how each
// schema field maps to the live DOM (type, required, options, whether fillable).
// Usage: PERSONA=qa node src/dbg-greenhouse.js <greenhouse-url>
const { chromium } = require('playwright');
const { fetchJson } = require('./ats-apis');

const URL = process.argv[2];
if (!URL) { console.error('pass a greenhouse url'); process.exit(1); }

function parseGh(url) {
  const m = url.match(/greenhouse\.io\/([a-z0-9][a-z0-9_.-]*)\/jobs\/(\d+)/i);
  return m ? { token: m[1], id: m[2] } : null;
}

(async () => {
  const p = parseGh(URL);
  const { json: schema } = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${p.token}/jobs/${p.id}?questions=true`);
  console.log('Schema questions:');
  for (const q of schema.questions || []) {
    for (const f of q.fields || []) {
      const opts = f.values ? ' OPTIONS=[' + f.values.map(v => v.label).join(' | ') + ']' : '';
      console.log(`  ${f.name} :: ${f.type} :: ${q.required ? 'REQ' : 'opt'} :: "${q.label}"${opts}`);
    }
  }

  const ctx = await chromium.launchPersistentContext('./browser-profile-discovery', { headless: true });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply for this Job")');
  if (applyBtn) await applyBtn.click().catch(() => {});
  await page.waitForTimeout(1500);

  // Find the form frame
  let form = page;
  for (const fr of page.frames()) if (/greenhouse\.io.*job_app|grnhse/i.test(fr.url())) form = fr;
  console.log('\nForm context:', form === page ? 'page' : form.url().slice(0, 80));

  // For each schema field, locate the DOM element & describe it.
  console.log('\nDOM mapping:');
  for (const q of schema.questions || []) {
    for (const f of q.fields || []) {
      const info = await form.evaluate((name) => {
        const el = document.querySelector(`[name="${name.replace(/"/g, '\\"')}"]`);
        if (!el) {
          // react-select hidden input? look for id-based or aria
          const byId = document.getElementById(name);
          if (!byId) return { found: false };
          return { found: true, tag: byId.tagName, type: byId.type, role: byId.getAttribute('role') };
        }
        return { found: true, tag: el.tagName, type: el.type, role: el.getAttribute('role'), visible: !!(el.offsetParent) };
      }, f.name).catch(() => ({ found: false, err: true }));
      console.log(`  ${f.name} (${f.type}) -> ${JSON.stringify(info)}`);
    }
  }

  // Dump all combobox/select elements actually present
  const selectors = await form.evaluate(() => {
    const out = [];
    document.querySelectorAll('input[role="combobox"], select, [class*="select__control"]').forEach(el => {
      const lbl = (el.closest('div')?.innerText || '').slice(0, 60).replace(/\n/g, ' ');
      out.push(`${el.tagName}.${el.className?.slice?.(0, 40) || ''} role=${el.getAttribute('role') || ''} :: ${lbl}`);
    });
    return out;
  }).catch(() => []);
  console.log('\nLive select-like controls:');
  selectors.forEach(s => console.log('  ', s));

  await page.screenshot({ path: 'dbg-greenhouse.png', fullPage: true }).catch(() => {});
  console.log('\nScreenshot: dbg-greenhouse.png');
  await ctx.close();
})();
