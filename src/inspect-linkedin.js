// One-off DOM inspector: opens a LinkedIn job in the cloud profile, dumps the
// apply-button markup, clicks Easy Apply, and dumps the modal structure so we
// can fix selectors with ground truth instead of guessing.
//
//   PERSONA=cloud node src/inspect-linkedin.js <jobViewUrl>

const { chromium } = require('playwright');
const answers = require('./answers');

const sleep = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const jobUrl = process.argv[2] || 'https://www.linkedin.com/jobs/view/4415022648/';
  const ctx = await chromium.launchPersistentContext(answers.browserProfile, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(jobUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(page, 4000);

  console.log('URL:', page.url());
  console.log('LOGGED IN:', !/authwall|\/login/i.test(page.url()));

  // Dump every button that looks like an apply control.
  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      cls: b.className.slice(0, 80),
      aria: b.getAttribute('aria-label') || '',
      text: (b.innerText || '').trim().slice(0, 40),
    })).filter(b => /apply/i.test(b.aria + b.text));
  }).catch(() => []);
  console.log('\nAPPLY BUTTONS:');
  buttons.forEach(b => console.log('  ', JSON.stringify(b)));

  // REAL Playwright click (trusted event) via role/name — not JS .click().
  let clicked = false;
  try {
    const btn = page.getByRole('button', { name: /easy apply/i }).first();
    await btn.scrollIntoViewIfNeeded({ timeout: 4000 });
    await btn.click({ timeout: 6000 });
    clicked = true;
  } catch (e) { console.log('  real click failed:', e.message.slice(0, 80)); }
  console.log('\nReal click apply button:', clicked);
  await sleep(page, 3500);

  const modalInfo = await page.evaluate(() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-modal, [class*="easy-apply"]'));
    return dialogs.map(d => ({
      cls: d.className.slice(0, 100),
      role: d.getAttribute('role'),
      heading: d.querySelector('h1,h2,h3')?.innerText?.slice(0, 60) || '',
      buttons: Array.from(d.querySelectorAll('button')).map(b => (b.getAttribute('aria-label') || b.innerText || '').trim().slice(0, 30)).filter(Boolean),
      inputs: Array.from(d.querySelectorAll('input,select,textarea')).map(i => `${i.tagName}:${i.type || ''}:${(i.getAttribute('aria-label') || i.name || i.id || '').slice(0, 40)}`),
    }));
  }).catch(() => []);
  console.log('\nMODAL(S) AFTER CLICK:');
  console.log(JSON.stringify(modalInfo, null, 2));

  console.log('\n(Leaving browser open 20s for visual inspection — will NOT submit anything.)');
  await sleep(page, 20000);
  await ctx.close();
  process.exit(0);
})();
