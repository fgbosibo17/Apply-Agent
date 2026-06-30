// Generic ATS form inspector. Opens a URL in real Chrome, navigates into the
// application form, and dumps every field with its associated label, plus buttons
// and captcha/iframe signals. Usage: node src/dbg-form.js <url> [applyButtonText]
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  const ctx = await chromium.launchPersistentContext('./browser-profile-qa', { headless: false, channel: 'chrome', viewport: null });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch((e) => console.log('goto err', e.message));
  await page.waitForTimeout(2500);

  // Dismiss cookie consent banners that overlay the form.
  for (const t of ['Accept all', 'Accept All', 'Accept', 'Allow all', 'I agree', 'Got it']) {
    const c = await page.$(`button:has-text("${t}")`).catch(() => null);
    if (c) { await c.click().catch(() => {}); await page.waitForTimeout(800); break; }
  }

  // Try to reveal the application form via common apply buttons.
  for (const t of ['Apply for this Job', 'Apply for this job', 'Apply Now', 'Apply now', "I'm interested", 'Apply', 'Submit application']) {
    const b = await page.$(`a:has-text("${t}"), button:has-text("${t}")`).catch(() => null);
    if (b) { await b.click().catch(() => {}); await page.waitForTimeout(2500); break; }
  }
  await page.waitForTimeout(1500);
  console.log('FINAL URL:', page.url());

  const dump = await page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.innerText.trim(); }
      let p = el.parentElement;
      for (let i = 0; i < 5 && p; i++) { const l = p.querySelector('label, legend')?.innerText; if (l) return l.trim(); p = p.parentElement; }
      return el.getAttribute('aria-label') || el.placeholder || '';
    };
    const fields = Array.from(document.querySelectorAll('input,select,textarea'))
      .filter((e) => e.type !== 'hidden')
      .map((e) => ({ tag: e.tagName, type: e.type, name: e.name || '', id: e.id || '', role: e.getAttribute('role') || '', req: e.required || /\*/.test(labelFor(e)), label: labelFor(e).slice(0, 60).replace(/\n/g, ' ') }));
    const buttons = Array.from(document.querySelectorAll('button,a[role="button"],input[type="submit"]')).map((b) => (b.innerText || b.value || '').trim()).filter(Boolean).slice(0, 20);
    const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src).filter((s) => /captcha/i.test(s));
    return { count: fields.length, fields, buttons, captchaFrames: iframes };
  }).catch((e) => ({ err: e.message }));

  console.log(JSON.stringify(dump, null, 1));
  await ctx.close();
})();
