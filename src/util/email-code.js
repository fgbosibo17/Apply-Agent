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

// ── The fallback, and why it is only a fallback ─────────────────────────────
//
// Everything above is the PRIMARY path and stays that way. It opens a second tab in
// the SAME persistent context, where the persona profile is already signed into Gmail,
// and reads the code out of the web UI. No password, no IMAP, no stored credential.
// It is also better for anti-bot reasons than an out-of-band relay: the code is read
// in the same warm session that is filling the form, from the same IP and the same
// browser fingerprint.
//
// Its weakness is that it scrapes Gmail's DOM — `tr.zA` for a message row, `h2.hP` for
// the subject, `.a3s` for the body. Google changes those without notice, and when they
// change the functions above return null. Silently. That failure mode is what turns
// into abandoned applications nobody hears about.
//
// So: the orchestrator endpoint is called ONLY after the primary has returned null,
// never before, and EVERY fallback is recorded as friction. The friction record is the
// point — it makes DOM breakage a visible, countable event instead of a slow decay.
// Two fallbacks in a night is a bad night; forty means the selectors have moved.
const orchestrator = require('./orchestrator');

function recordFallback(what, detail) {
  try {
    require('../core/queues').frictionRecord({
      area: 'email-code:gmail-dom',
      reproducible: true,
      summary: `Gmail scrape returned null for ${what}; used the orchestrator fallback. `
        + 'Selectors tr.zA / h2.hP / .a3s may have changed.',
      signature: `gmail-dom-null:${what}${detail ? ':' + detail : ''}`,
    });
  } catch { /* friction is a diagnostic; never let it break a run */ }
}

// getEmailCode, then the endpoint. Returns { code, via, fallbackError }.
// `via` is 'browser' | 'endpoint' | null — the caller reports which path produced the
// code, so a run's dependence on the fallback is visible in its output.
async function getEmailCodeOrFallback(context, opts = {}) {
  const primary = await getEmailCode(context, opts).catch(() => null);
  if (primary) return { code: primary, via: 'browser' };

  // Only now.
  recordFallback('code');
  if (!orchestrator.emailCodeEndpoint()) {
    return { code: null, via: null, fallbackError: 'APPLY_AGENT_EMAIL_CODE_ENDPOINT is unset' };
  }
  console.log('   Gmail scrape found no code — asking the orchestrator (fallback)...');
  const res = await orchestrator.emailCode({
    query: opts.query || '', digits: opts.digits || null, jobUrl: opts.jobUrl || '', want: 'code',
  });
  if (res.ok && res.code) {
    console.log(`   orchestrator returned a code${res.retried ? ' (after one retry)' : ''}.`);
    return { code: res.code, via: 'endpoint' };
  }
  return { code: null, via: null, fallbackError: res.error || 'no code from the endpoint' };
}

// Same shape for confirmation links.
async function getConfirmLinkOrFallback(context, opts = {}) {
  const primary = await getConfirmLink(context, opts).catch(() => null);
  if (primary) return { link: primary, via: 'browser' };

  recordFallback('link');
  if (!orchestrator.emailCodeEndpoint()) {
    return { link: null, via: null, fallbackError: 'APPLY_AGENT_EMAIL_CODE_ENDPOINT is unset' };
  }
  console.log('   Gmail scrape found no confirm link — asking the orchestrator (fallback)...');
  const res = await orchestrator.emailCode({
    query: opts.query || '', jobUrl: opts.jobUrl || '', want: 'link',
  });
  if (res.ok && res.link) return { link: res.link, via: 'endpoint' };
  return { link: null, via: null, fallbackError: res.error || 'no link from the endpoint' };
}


// ── Alphanumeric codes ────────────────────────────────────────────────────────
//
// extractCode() above matches \d{4,8}, which is right for the post-submit flows that
// email a numeric OTP. Greenhouse asks for an 8-character ALPHANUMERIC code before it
// will enable submit, and that pattern never matches it.
//
// Alphanumeric is harder to isolate than digits: an 8-character token of letters and
// numbers looks a lot like an ordinary word. So this only accepts a candidate that
// sits next to code-ish wording, or that mixes letters AND digits (real codes almost
// always do; English words do not). A run of plain letters is rejected rather than
// guessed at — a wrong code burns the attempt and the email.
function extractCodeAlnum(text, length) {
  if (!text) return null;
  const L = length || 8;
  // EXACT PHRASE FIRST (2026-09-14). Greenhouse writes, verbatim:
  //   Copy and paste this code into the security code field on your application: Dj8jx5W0
  // Three things below get that wrong. The `near` pattern cannot reach it: with the
  // /i flag [^A-Z0-9] excludes letters, and there are whole words between the last
  // anchor word and the code, so it always fell through to the weakest rule. That
  // rule then requires a letter AND a digit, which discards a perfectly real code
  // like MLKmlITN. And .toUpperCase() rewrites a code the email explicitly told us
  // to copy and paste. Anchoring on the literal sentence removes the guessing that
  // the strictness existed to prevent: whatever follows that colon IS the code -
  // any length, any composition, in the case it was sent.
  const exact = text.match(/security code field on your application:\s*([A-Za-z0-9]{5,14})/i);
  if (exact) return exact[1];
  const TOKEN = `[A-Z0-9]{${L}}`;

  const mixed = (s) => /[A-Z]/.test(s) && /[0-9]/.test(s);

  // Strongest: the token appears right after the words that introduce it.
  const near = new RegExp(
    `(?:code|verification|verify|security|one[- ]time)[^A-Z0-9]{0,40}(${TOKEN})\\b`, 'i');
  const m1 = near.exec(text);
  if (m1) return m1[1].toUpperCase();

  // Or immediately before them ("XY12AB34 is your code").
  const after = new RegExp(
    `\\b(${TOKEN})[^A-Z0-9]{0,30}(?:is your|to (?:verify|submit|confirm))`, 'i');
  const m2 = after.exec(text);
  if (m2) return m2[1].toUpperCase();

  // Last resort: a standalone token that mixes letters and digits.
  const all = [...text.matchAll(new RegExp(`\\b(${TOKEN})\\b`, 'gi'))].map((m) => m[1].toUpperCase());
  return all.find(mixed) || null;
}

// Same Gmail plumbing as getEmailCode, different extractor. Kept separate rather than
// adding a flag so the digit path — which is working and in use by three handlers —
// cannot regress from a change made for Greenhouse.
async function getEmailCodeAlnum(context, { query = 'verification OR code OR security', length = 8, timeoutMs = 150000 } = {}) {
  const tab = await context.newPage();
  try {
    if (!(await ensureGmail(tab))) return null;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const text = await readNewestEmail(tab, query);
      const code = extractCodeAlnum(text, length);
      if (code) { console.log(`   retrieved ${length}-character email code: ${code}`); return code; }
      await tab.waitForTimeout(5000);
    }
    return null;
  } finally { await tab.close().catch(() => {}); }
}
module.exports = {
  extractCodeAlnum, getEmailCodeAlnum,
  getEmailCode, getConfirmLink, extractCode,
  getEmailCodeOrFallback, getConfirmLinkOrFallback,
};
