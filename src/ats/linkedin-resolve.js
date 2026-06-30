// Resolve a LinkedIn /jobs/view/<id> listing to its external company-ATS apply URL.
// Per the project rule: only take jobs with an EXTERNAL apply link. Easy-Apply-only
// jobs are skipped (they live in LinkedIn's DB, not the company's ATS).
//
// Returns one of:
//   { externalUrl: 'https://boards.greenhouse.io/...' }  → dispatch to ATS handler
//   { easyApply: true }                                   → skip (no external ATS)
//   { closed: true }                                      → listing gone / no longer accepting
//   { error: 'reason' }

async function resolveLinkedInApplyUrl(ctx, page, job) {
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const body = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
  if (/no longer accepting applications|this job is no longer|job is closed/i.test(body)) {
    return { closed: true };
  }

  // Wait for the apply button to render (LinkedIn hydrates it late), scroll it in.
  await page.waitForSelector('.jobs-apply-button, button.jobs-apply-button', { timeout: 8000 }).catch(() => {});
  await page.evaluate(() => {
    document.querySelector('.jobs-apply-button')?.scrollIntoView({ block: 'center' });
  }).catch(() => {});
  await page.waitForTimeout(600);

  // Find the apply button and read its label to tell Easy Apply from external.
  const btnInfo = await page.evaluate(() => {
    const btn = document.querySelector('.jobs-apply-button') ||
      Array.from(document.querySelectorAll('button')).find(b => /easy apply|^apply$/i.test(b.innerText.trim()));
    if (!btn) return { found: false };
    const label = (btn.getAttribute('aria-label') || btn.innerText || '').trim();
    return { found: true, label, easy: /easy apply/i.test(label) };
  }).catch(() => ({ found: false }));

  if (!btnInfo.found) return { error: 'no apply button' };
  if (btnInfo.easy) return { easyApply: true };

  // External apply: clicking opens a new tab to the company ATS. Capture its URL.
  let popup = null;
  const popupPromise = ctx.waitForEvent('page', { timeout: 12000 }).catch(() => null);
  await page.evaluate(() => {
    const btn = document.querySelector('.jobs-apply-button') ||
      Array.from(document.querySelectorAll('button')).find(b => /^apply$/i.test(b.innerText.trim()));
    btn?.click();
  }).catch(() => {});

  popup = await popupPromise;
  if (!popup) {
    // Sometimes LinkedIn navigates in-place instead of a popup.
    await page.waitForTimeout(1500);
    const cur = page.url();
    if (!/linkedin\.com/i.test(cur)) return { externalUrl: cur.split('#')[0] };
    return { error: 'no external tab opened' };
  }

  await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
  await popup.waitForTimeout(1000);
  const externalUrl = popup.url().split('#')[0];
  await popup.close().catch(() => {});

  if (/linkedin\.com/i.test(externalUrl) || !/^https?:/i.test(externalUrl)) {
    return { error: 'external url did not resolve' };
  }
  return { externalUrl };
}

module.exports = { resolveLinkedInApplyUrl };
