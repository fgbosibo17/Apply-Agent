// Greenhouse's pre-submit "confirm you're a human" email code.
//
// WHY THIS IS ITS OWN MODULE RATHER THAN handleEmailVerification
//
// The other handlers (lever, ashby, workable) call handleEmailVerification AFTER
// clicking submit: the application is already in, and the code finalises it. Greenhouse
// is the opposite shape — it disables the submit button until the code is entered, so
// the code has to be fetched and typed BEFORE the click.
//
// ADAPTIVE DESIGN (updated 2026-09-05)
// Greenhouse has changed its verification UI wording multiple times. Rather than
// maintaining a brittle list of exact phrases, this module:
//   1. Detects ANY code prompt using a broad regex + DOM signal (input[maxlength="1"]
//      or autocomplete="one-time-code") as a secondary confirmation.
//   2. Infers code length from the page text OR by counting the input boxes.
//   3. Infers code format (alphanumeric vs digits-only) from the page text.
//   4. Tries multiple Gmail search queries so wording changes on Greenhouse's email
//      side don't silently break retrieval.
//   5. Falls back to a single-box fill if the multi-box widget is not found.
//
// Any new Greenhouse wording variant should be caught without a code change here.

const { getEmailCodeAlnum, getEmailCode } = require('./email-code');

// ── Detection ──────────────────────────────────────────────────────────────
//
// Broad catch-all: any phrase that could introduce a one-time code prompt.
// Ordered from most-specific (least false-positive risk) to broadest.
const NEEDS_CODE = new RegExp(
  [
    // Explicit code/OTP mentions
    'security code',
    'verification code',
    'confirm.*code',
    'enter.*code',
    'code.*sent',
    'code.*emailed',
    'code.*email',
    'one[- ]time.*code',
    'otp',
    // Generic "we sent you something" patterns
    "we('ve| have) sent",
    'a code has been',
    'check your email.*code',
    'email.*code',
    // Greenhouse-specific historical phrases
    'confirm you\'?re a human',
    'verify your email',
    'human verification',
    // Catch-all: any N-character code prompt
    '\\d+[- ]character code',
    '\\d+[- ]digit code',
  ].join('|'),
  'i'
);

// Secondary DOM signal: if the page has multi-box or OTP inputs, treat it as a
// code prompt even if none of the text phrases match (Greenhouse may render the
// prompt text inside a shadow DOM or iframe we can't read).
async function hasDomCodeSignal(scope) {
  const boxes = await scope.$$('input[maxlength="1"]').catch(() => []);
  if (boxes.length >= 4) return true;
  const otp = await scope.$$('input[autocomplete="one-time-code"]').catch(() => []);
  return otp.length > 0;
}

// ── Code length inference ──────────────────────────────────────────────────
//
// Try to read the expected length from the page text. If not found, count the
// input boxes. If still ambiguous, default to 8 (current Greenhouse standard).
async function inferCodeLength(text, scope) {
  // Explicit "N-character" or "N-digit" mention
  const explicit = /(\d+)[- ](?:character|digit)/i.exec(text || '');
  if (explicit) {
    const n = parseInt(explicit[1], 10);
    if (n >= 4 && n <= 12) return n;
  }
  // Count maxlength="1" boxes
  const boxes = await scope.$$('input[maxlength="1"]').catch(() => []);
  if (boxes.length >= 4 && boxes.length <= 12) return boxes.length;
  return 8; // Greenhouse default
}

// ── Format inference ───────────────────────────────────────────────────────
//
// Decide whether to use the alphanumeric or digit-only extractor.
// Alphanumeric codes contain letters; digit codes are purely numeric.
// Default to alphanumeric (Greenhouse's current format) unless the page
// explicitly says "digit" or the boxes are clearly numeric.
function inferCodeFormat(text) {
  if (/\d+[- ]digit/i.test(text || '')) return 'digits';
  if (/numeric|digits only|numbers only/i.test(text || '')) return 'digits';
  return 'alnum'; // Greenhouse default: alphanumeric
}

// ── Input box discovery ────────────────────────────────────────────────────
//
// Returns boxes in priority order:
//   1. maxlength="1" inputs (multi-box widget, most reliable signal)
//   2. autocomplete="one-time-code" input (single-field OTP)
//   3. Any input near a "code" or "security" label
async function findCodeBoxes(scope) {
  // Wait up to 4s for inputs to appear (some pages render after a short delay)
  const waitForAny = async (selector, ms = 4000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const els = await scope.$$(selector).catch(() => []);
      if (els.length) return els;
      await new Promise(r => setTimeout(r, 400));
    }
    return [];
  };

  // Multi-box: individual character inputs (maxlength=1 or maxlength=2)
  const multi = await waitForAny('input[maxlength="1"], input[maxlength="2"]');
  if (multi.length >= 4) return { boxes: multi, mode: 'multi' };

  // Single OTP field
  const otpField = await scope.$('input[autocomplete="one-time-code"]').catch(() => null);
  if (otpField) return { boxes: [otpField], mode: 'single' };

  // Labelled inputs near security/code text — extended selectors
  const labelled = await scope.$$(
    '[class*="security" i] input, [id*="security" i] input, '
    + '[aria-label*="code" i], [placeholder*="code" i], '
    + '[name*="code" i], [name*="otp" i], [name*="token" i], '
    + '[class*="otp" i] input, [class*="verify" i] input, [id*="otp" i], '
    + '[class*="pin" i] input, [data-testid*="code" i], [data-testid*="otp" i]'
  ).catch(() => []);
  if (labelled.length >= 1) return { boxes: labelled, mode: labelled.length === 1 ? 'single' : 'multi' };

  // Iframe fallback: check all child frames
  try {
    const frames = typeof scope.frames === 'function' ? scope.frames() : [];
    for (const frame of frames) {
      const fi = await frame.$$('input[maxlength="1"]').catch(() => []);
      if (fi.length >= 4) return { boxes: fi, mode: 'multi' };
      const fo = await frame.$('input[autocomplete="one-time-code"]').catch(() => null);
      if (fo) return { boxes: [fo], mode: 'single' };
    }
  } catch {}

  // Last resort: any short visible text input not name/email/file
  try {
    const anyInput = await scope.$$('input[type="text"]:not([name*="name" i]):not([name*="email" i])').catch(() => []);
    const visible = [];
    for (const el of anyInput) {
      const vis = await el.isVisible().catch(() => false);
      if (vis) visible.push(el);
    }
    if (visible.length >= 1 && visible.length <= 3) return { boxes: visible, mode: 'single' };
  } catch {}

  return { boxes: [], mode: 'none' };
}

// ── Fill strategy ──────────────────────────────────────────────────────────
//
// Multi-box: type into the first, rely on auto-advance, repair if needed.
// Single-box: fill directly.
async function fillCode(page, boxes, code, mode) {
  if (mode === 'single' || boxes.length === 1) {
    await boxes[0].click().catch(() => {});
    await boxes[0].fill(code).catch(async () => {
      await boxes[0].type(code, { delay: 60 }).catch(() => {});
    });
    await page.waitForTimeout(300);
    const val = await boxes[0].inputValue().catch(() => '');
    return val.replace(/\s/g, '').length >= Math.min(code.length, 4);
  }

  // Multi-box: type and auto-advance
  await boxes[0].click().catch(() => {});
  await page.keyboard.type(code, { delay: 70 }).catch(() => {});
  await page.waitForTimeout(400);

  const filled = await Promise.all(
    boxes.map((b) => b.inputValue().then((v) => (v || '').trim()).catch(() => ''))
  );
  if (filled.filter(Boolean).length >= code.length) return true;

  // Auto-advance failed: place each character manually
  for (let i = 0; i < Math.min(boxes.length, code.length); i++) {
    await boxes[i].click().catch(() => {});
    await boxes[i].fill(code[i]).catch(async () => {
      await page.keyboard.type(code[i], { delay: 50 }).catch(() => {});
    });
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
  const again = await Promise.all(
    boxes.map((b) => b.inputValue().then((v) => (v || '').trim()).catch(() => ''))
  );
  return again.filter(Boolean).length >= code.length;
}

// ── Gmail search queries ───────────────────────────────────────────────────
//
// Tried in order. Multiple queries so Greenhouse email wording changes don't
// silently break code retrieval.
const EMAIL_QUERIES = [
  'subject:"security code" newer_than:5m',
  'subject:"verification code" newer_than:5m',
  '"security code" greenhouse newer_than:5m',
  '"verification code" greenhouse newer_than:5m',
  'greenhouse "code" newer_than:10m',
  '"code" application newer_than:10m',
  'security code newer_than:15m',
  'verification code newer_than:15m',
];

async function fetchCode(context, { length, format, timeoutMs = 150000, company = '', usedCodes = null }) {
  const getterAlnum = (q) => getEmailCodeAlnum(context, { length, query: q, timeoutMs: Math.min(timeoutMs, 30000) }).catch(() => null);
  const getterDigit = (q) => getEmailCode(context, { query: q, digits: length, timeoutMs: Math.min(timeoutMs, 30000) }).catch(() => null);
  const getter = format === 'digits' ? getterDigit : getterAlnum;

  // Build company-specific queries FIRST so we grab the right code when
  // multiple sessions are applying simultaneously (avoids cross-session code theft).
  const companyQueries = [];
  if (company) {
    const co = company.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    if (co) {
      companyQueries.push(`subject:"security code" "${co}" newer_than:5m`);
      companyQueries.push(`subject:"verification code" "${co}" newer_than:5m`);
      companyQueries.push(`"security code" "${co}" newer_than:10m`);
      companyQueries.push(`"${co}" "code" newer_than:10m`);
    }
  }
  // Fall back to generic queries if company-specific finds nothing
  const allQueries = [...companyQueries, ...EMAIL_QUERIES];

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    const query = allQueries[attempt % allQueries.length];
    const code = await getter(query);
    if (code) {
      // Skip codes we already tried (stale email from a previous attempt)
      if (usedCodes && usedCodes.has(code)) {
        if (process.env.DBG_SELECT) console.log(`    ⚠️  verification: skipping already-used code ${code.slice(0,3)}...`);
      } else {
        if (company) console.log(`    ✅ verification: matched code to company "${company}"`);
        return code;
      }
    }
    attempt++;
    if (attempt % allQueries.length === 0) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  return null;
}

// ── Main handler ───────────────────────────────────────────────────────────
//
// Returns null to proceed to submit, or a result object for the handler to return.
async function handleGreenhouseVerification(page, scope, { jobMeta = {} } = {}) {
  // Read page text
  let text = '';
  try {
    text = await scope.evaluate(() => document.body.innerText.slice(0, 6000));
  } catch { /* ignore */ }

  // Check text patterns first, then DOM signal as fallback
  const textMatch = NEEDS_CODE.test(text);
  const domMatch = textMatch ? false : await hasDomCodeSignal(scope);

  if (!textMatch && !domMatch) return null; // No code prompt detected

  const detectedVia = textMatch ? 'text' : 'dom';
  const len = await inferCodeLength(text, scope);
  const fmt = inferCodeFormat(text);

  console.log(`    🔐 verification: code prompt detected (via ${detectedVia}) — ${len}-char ${fmt} code expected for ${jobMeta.company || 'this job'}`);

  // Find input boxes
  const { boxes, mode } = await findCodeBoxes(scope);
  if (boxes.length === 0) {
    console.log(`    ⚠️  verification: code inputs not found on page`);
    return {
      status: 'Skipped',
      reason: 'Greenhouse asked for a verification code but no input boxes were found',
      attention: {
        kind: 'verification-ui-changed',
        severity: 'blocking',
        summary: `${jobMeta.company || 'A job'} requested a ${len}-char code but no input boxes matched. `
          + 'The UI may have changed (check maxlength="1", autocomplete="one-time-code", and label-adjacent inputs).',
        nextAction: 'Submit by hand and update findCodeBoxes() to match the new markup.',
      },
    };
  }
  console.log(`    📋 verification: found ${boxes.length} input box(es) (mode: ${mode})`);

  // Fetch the code from Gmail
  console.log(`    📧 verification: fetching ${len}-char ${fmt} code from Gmail...`);
  const code = await fetchCode(page.context(), { length: len, format: fmt, timeoutMs: 150000, company: jobMeta.company || '', usedCodes: page._usedVerifyCodes || null });

  if (!code) {
    console.log(`    ❌ verification: no code found in Gmail within timeout`);
    return {
      status: 'Skipped',
      reason: `No ${len}-character ${fmt} code found in Gmail within the wait window`,
      attention: {
        kind: 'verification-code-missing',
        severity: 'blocking',
        summary: `${jobMeta.company || 'A job'} sent a ${len}-char code but it was not readable from Gmail. `
          + 'The application form is filled but unsubmitted.',
        nextAction: 'Check the persona inbox for the code and submit by hand. Confirm Gmail is signed in on this machine.',
      },
    };
  }
  console.log(`    ✅ verification: code retrieved (${code.length} chars, format: ${fmt})`);

  // Enter the code
  const filled = await fillCode(page, boxes, code, mode);
  if (!filled) {
    console.log(`    ❌ verification: code retrieved but boxes would not accept it`);
    return {
      status: 'Skipped',
      reason: 'Verification code retrieved but could not be entered into the input boxes',
      attention: {
        kind: 'verification-fill-failed',
        severity: 'blocking',
        summary: `Retrieved the ${len}-char code for ${jobMeta.company || 'a job'} but filling failed. `
          + 'Code is still valid in the inbox.',
        nextAction: 'Submit by hand using the code in the persona inbox.',
      },
    };
  }

  console.log(`    ✅ verification: ${len}-char ${fmt} code entered successfully`);
  // Mark this code as used so we don't re-enter it if submit fails and re-triggers.
  // Store on the page context so subsequent calls in the same application know.
  if (!page._usedVerifyCodes) page._usedVerifyCodes = new Set();
  page._usedVerifyCodes.add(code);
  await page.waitForTimeout(600);
  return null;
}

module.exports = { handleGreenhouseVerification, inferCodeLength, inferCodeFormat, findCodeBoxes, NEEDS_CODE };
