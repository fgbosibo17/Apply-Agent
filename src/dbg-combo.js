// Focused probe: why does the "live/work in US" react-select not fill?
const { chromium } = require('playwright');
const answers = require('./answers');
const URL = process.argv[2];
const NAME = process.argv[3] || 'question_35010867002';

(async () => {
  const ctx = await chromium.launchPersistentContext(answers.browserProfile, { headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'] });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await page.waitForSelector('input#first_name, input[name="first_name"]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const form = page;

  const sel = `[name="${NAME}"], [id="${NAME}"]`;
  const input = await form.$(sel);
  console.log('input found?', !!input);
  if (input) {
    const meta = await input.evaluate((el) => ({
      tag: el.tagName, type: el.type, role: el.getAttribute('role'), name: el.name, id: el.id,
      visible: !!el.offsetParent,
      ariaExpanded: el.getAttribute('aria-expanded'),
      // walk up for a <label>
      label: (() => { let p = el.parentElement; for (let i = 0; i < 8 && p; i++) { const l = p.querySelector('label'); if (l && l.innerText.trim()) return l.innerText.trim().slice(0, 80); p = p.parentElement; } return '(none)'; })(),
    }));
    console.log('meta:', JSON.stringify(meta, null, 2));

    // Replicate production fillSelect EXACTLY: click → fill("Yes") → click option.
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click().catch(() => {});
    await page.waitForTimeout(150);
    const fillErr = await input.fill('Yes').then(() => null).catch((e) => e.message);
    console.log('input.fill("Yes") error:', fillErr || '(none)');
    await page.waitForTimeout(400);
    const opts = await form.$$eval('[role="option"], .select__option, [id*="-option-"]', (els) => els.filter((e) => e.offsetParent !== null).map((e) => ({ t: e.textContent.trim(), id: e.id })));
    console.log('opts after fill:', JSON.stringify(opts));
    const ok = await form.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[role="option"], .select__option, [id*="-option-"]')).filter((e) => e.offsetParent !== null);
      const hit = els.find((e) => /^yes$/i.test(e.textContent.trim()));
      if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return true; }
      return false;
    });
    console.log('clicked Yes after fill?', ok);
    await page.waitForTimeout(500);
    const after = await input.evaluate((el) => {
      const ctrl = el.closest('.select__control') || el.closest('[class*="select__control"]');
      return ctrl ? ctrl.innerText.slice(0, 40) : '(no ctrl)';
    });
    console.log('control text after:', JSON.stringify(after));
  }
  await ctx.close();
})();
