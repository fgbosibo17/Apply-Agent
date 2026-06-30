// Inspect a Greenhouse job to crack the "submit button not found" / "no confirmation"
// failures. Reports: redirected URL, iframe presence, form-field counts in main frame
// vs each iframe, submit buttons, and required labels.
//
//   PERSONA=cloud node src/inspect-greenhouse.js <url>

const { chromium } = require('playwright');
const answers = require('./answers');

const sleep = (p, ms) => p.waitForTimeout(ms);

(async () => {
  const url = process.argv[2] || 'https://boards.greenhouse.io/mks2technologies/jobs/6016237004';
  const ctx = await chromium.launchPersistentContext(answers.browserProfile, {
    headless: false, channel: 'chrome', viewport: null, args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(page, 3500);

  console.log('Final URL:', page.url());

  // Frames
  const frames = page.frames();
  console.log(`\nFrames: ${frames.length}`);
  for (const f of frames) {
    const counts = await f.evaluate(() => ({
      url: location.href.slice(0, 80),
      inputs: document.querySelectorAll('input:not([type=hidden])').length,
      textareas: document.querySelectorAll('textarea').length,
      selects: document.querySelectorAll('select').length,
      submitButtons: Array.from(document.querySelectorAll('button,input[type=submit]'))
        .filter(b => /submit/i.test((b.innerText || b.value || '') + (b.getAttribute('aria-label') || '')))
        .map(b => (b.innerText || b.value || '').trim().slice(0, 30)),
      anyApplyBtn: Array.from(document.querySelectorAll('a,button'))
        .filter(b => /^apply/i.test((b.innerText || '').trim()))
        .map(b => (b.innerText || '').trim().slice(0, 30)),
    })).catch(e => ({ error: e.message.slice(0, 60) }));
    console.log(`  frame: ${JSON.stringify(counts)}`);
  }

  // Main-frame required labels
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('label')).filter(l => /\*/.test(l.innerText)).map(l => l.innerText.trim().slice(0, 50)).slice(0, 25)
  ).catch(() => []);
  console.log('\nMain-frame required labels:', JSON.stringify(labels, null, 1));

  console.log('\n(Browser open 15s — not submitting.)');
  await sleep(page, 15000);
  await ctx.close();
  process.exit(0);
})();
