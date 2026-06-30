// Retrieve a one-time email verification code WITHOUT storing any password.
//
// Strategy: open a second tab in the SAME persistent browser context (the persona
// profile is already signed into Gmail), search recent mail, and extract the code.
// Many ATS flows (Workable, some SmartRecruiters/iCIMS) email a 4-8 digit code or
// a "confirm your application" link before the submission is final.
//
// Two helpers:
//   getEmailCode(context, opts)  -> digits string (or null)
//   getConfirmLink(context, opts) -> confirmation URL (or null)
//
// Gmail must be logged into the persona's browser profile. If it isn't, we surface
// a prompt and wait (human-in-the-loop), never touching credentials ourselves.

const GMAIL_SEARCH = (q) => 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(q);

async function ensureGmail(tab) {
  await tab.goto('https://mail.google.com/mail/u/0/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await tab.waitForTimeout(2500);
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(tab.url())) {
    console.log('\n📧 Gmail is not logged in for this persona. Please sign in to Gmail in the opened tab; I will continue once you are in the inbox.');
    try { await tab.bringToFront(); } catch {}
    const start = Date.now();
    while (Date.now() - start < 180000) {
      await tab.waitForTimeout(3000);
      if (/mail\.google\.com\/mail/i.test(tab.url()) && !/signin|ServiceLogin/i.test(tab.url())) return true;
    }
    return false;
  }
  return true;
}

// Read the text of the newest matching email (opens it).
async function readNewestEmail(tab, query) {
  await tab.goto(GMAIL_SEARCH(query + ' newer_than:1h'), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await tab.waitForTimeout(2500);
  const row = await tab.$('tr.zA');
  if (!row) return '';
  await row.click().catch(() => {});
  await tab.waitForTimeout(2000);
  // Subject + body text
  return tab.evaluate(() => {
    const subj = document.querySelector('h2.hP')?.innerText || '';
    const body = document.querySelector('.a3s')?.innerText || document.body.innerText || '';
    return (subj + '\n' + body).slice(0, 4000);
  }).catch(() => '');
}

// Extract the most likely verification code from email text. Prefers digits that
// appear next to words like code/verification/OTP; falls back to a standalone
// 4-8 digit group; avoids years and phone-like numbers.
function extractCode(text, digits) {
  if (!text) return null;
  const near = text.match(/(?:code|verification|verify|otp|pin|one[- ]time)[^\d]{0,40}(\d{4,8})/i);
  if (near) return near[1];
  const after = text.match(/(\d{4,8})[^\d]{0,30}(?:is your|to verify|verification)/i);
  if (after) return after[1];
  if (digits) { const exact = text.match(new RegExp('\\b(\\d{' + digits + '})\\b')); if (exact) return exact[1]; }
  const generic = [...text.matchAll(/\b(\d{4,8})\b/g)].map((m) => m[1]).filter((n) => !/^(19|20)\d\d$/.test(n));
  return generic[0] || null;
}

async function getEmailCode(context, { query = 'verify OR verification OR code OR confirm OR application', digits = null, timeoutMs = 120000 } = {}) {
  const tab = await context.newPage();
  try {
    if (!(await ensureGmail(tab))) return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = await readNewestEmail(tab, query);
      const code = extractCode(text, digits);
      if (code) { console.log(`   retrieved email code: ${code}`); return code; }
      await tab.waitForTimeout(5000); // wait for the email to arrive, retry
    }
    return null;
  } finally { await tab.close().catch(() => {}); }
}

async function getConfirmLink(context, { query = 'confirm OR verify OR application', domainHint = '', timeoutMs = 120000 } = {}) {
  const tab = await context.newPage();
  try {
    if (!(await ensureGmail(tab))) return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await tab.goto(GMAIL_SEARCH(query + ' newer_than:1h'), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await tab.waitForTimeout(2500);
      const row = await tab.$('tr.zA');
      if (row) {
        await row.click().catch(() => {});
        await tab.waitForTimeout(2000);
        const href = await tab.evaluate((hint) => {
          const links = Array.from(document.querySelectorAll('.a3s a[href]')).map((a) => a.href);
          const m = links.find((h) => /confirm|verify|activate|complete/i.test(h) && (!hint || h.includes(hint)));
          return m || links.find((h) => hint && h.includes(hint)) || null;
        }, domainHint).catch(() => null);
        if (href) { console.log('   retrieved confirm link.'); return href; }
      }
      await tab.waitForTimeout(5000);
    }
    return null;
  } finally { await tab.close().catch(() => {}); }
}

module.exports = { getEmailCode, getConfirmLink, extractCode };
