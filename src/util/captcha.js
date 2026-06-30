// CAPTCHA strategy — honest about what is and isn't auto-solvable.
//
// There are two fundamentally different cases:
//
//  1. INVISIBLE / score-based (reCAPTCHA v3 & Enterprise, invisible hCaptcha).
//     These have NO challenge to click — they score the session silently. In a
//     REAL Chrome window with a warmed persona profile (which is exactly how the
//     runner launches: channel:'chrome', headless:false) they pass on their own.
//     This is why our Greenhouse submissions already succeed. Nothing to "solve".
//
//  2. INTERACTIVE challenge (reCAPTCHA v2 checkbox / image grid, hCaptcha grid).
//     These CANNOT be solved by code alone — that's the entire point of them.
//     Two honest options, in priority order:
//       a) A paid solving service (2Captcha / CapSolver) if an API key is set.
//       b) Human-in-the-loop: the browser is visible, so we surface a clear
//          prompt and WAIT for the user to solve it, polling for the token.
//
// handleCaptcha() implements all of the above and returns {ok, note}.

const https = require('https');

function httpsRequest(url, { method = 'GET', body = null } = {}) {
  return new Promise((resolve) => {
    const req = https.request(url, { method, headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {} }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d));
    });
    req.on('error', () => resolve(''));
    if (body) req.write(body);
    req.end();
  });
}

// Detect captcha presence, type, and whether a visible (interactive) challenge is shown.
async function detectCaptcha(scope) {
  return scope.evaluate(() => {
    const frames = Array.from(document.querySelectorAll('iframe'));
    const recap = frames.find((f) => /recaptcha/i.test(f.src || ''));
    const hcap = frames.find((f) => /hcaptcha/i.test(f.src || ''));
    const datadome = frames.find((f) => /captcha-delivery\.com|datadome/i.test(f.src || '')) ||
                     /datadome|captcha-delivery/i.test(document.body.innerText || '');
    const turnstile = frames.find((f) => /challenges\.cloudflare\.com/i.test(f.src || '')) ||
                      document.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]');
    const challengeVisible = frames.some((f) =>
      /(recaptcha\/api2\/bframe|hcaptcha\.com\/captcha|newassets\.hcaptcha|captcha-delivery)/i.test(f.src || '') &&
      f.offsetParent !== null && f.getBoundingClientRect().height > 80) || (!!datadome && !frames.find((f) => /enclave/i.test(f.src || '')));
    const sitekeyEl = document.querySelector('[data-sitekey]');
    return {
      present: !!(recap || hcap || datadome || turnstile || sitekeyEl),
      type: datadome ? 'datadome' : (turnstile ? 'turnstile' : (hcap ? 'hcaptcha' : (recap ? 'recaptcha' : (sitekeyEl ? 'unknown' : null)))),
      interactive: challengeVisible,
      sitekey: sitekeyEl ? sitekeyEl.getAttribute('data-sitekey') : null,
    };
  }).catch(() => ({ present: false }));
}

// Has a response token been produced (challenge solved / score accepted)?
async function isSolved(scope) {
  return scope.evaluate(() => {
    const tokens = ['textarea[name="g-recaptcha-response"]', 'textarea[name="h-captcha-response"]', 'textarea[id*="g-recaptcha-response"]', 'input[name="cf-turnstile-response"]'];
    return tokens.some((s) => { const e = document.querySelector(s); return e && e.value && e.value.length > 20; });
  }).catch(() => false);
}

// Inject a solved token from a paid service into the response fields.
async function injectToken(page, token) {
  await page.evaluate((tok) => {
    document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]').forEach((t) => {
      t.value = tok; t.dispatchEvent(new Event('change', { bubbles: true })); t.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (window.___grecaptcha_cfg && typeof window.onCaptchaSuccess === 'function') { try { window.onCaptchaSuccess(tok); } catch {} }
  }, token).catch(() => {});
}

// Solve via 2Captcha (used only when TWOCAPTCHA_KEY is set). Best-effort.
// Supports reCAPTCHA, hCaptcha, and Cloudflare Turnstile.
async function solveWith2Captcha(det, pageUrl) {
  const key = process.env.TWOCAPTCHA_KEY;
  if (!key || !det.sitekey) return null;
  const method = det.type === 'hcaptcha' ? 'hcaptcha' : (det.type === 'turnstile' ? 'turnstile' : 'userrecaptcha');
  const keyParam = (det.type === 'hcaptcha' || det.type === 'turnstile') ? 'sitekey' : 'googlekey';
  const inResp = await httpsRequest(
    `https://2captcha.com/in.php?key=${key}&method=${method}&${keyParam}=${det.sitekey}&pageurl=${encodeURIComponent(pageUrl)}&json=1`);
  let id; try { id = JSON.parse(inResp).request; } catch { return null; }
  if (!id) return null;
  for (let i = 0; i < 24; i++) { // poll up to ~2 min
    await new Promise((r) => setTimeout(r, 5000));
    const res = await httpsRequest(`https://2captcha.com/res.php?key=${key}&action=get&id=${id}&json=1`);
    try { const j = JSON.parse(res); if (j.status === 1) return j.request; } catch {}
  }
  return null;
}

// Main entry. Call right before submitting. Returns {ok, note}.
async function handleCaptcha(page, scope = page, { timeoutMs = 180000 } = {}) {
  const det = await detectCaptcha(scope);
  if (!det.present) return { ok: true, note: 'none' };
  if (await isSolved(scope)) return { ok: true, note: 'auto-passed' };

  if (!det.interactive) {
    // Invisible / score-based (reCAPTCHA v3, managed Turnstile). If a solver key is
    // set and we have a sitekey, solve it (Turnstile especially tends to hang for
    // bot-flagged sessions); otherwise give it a beat and proceed (real Chrome
    // usually passes reCAPTCHA v3).
    if (process.env.TWOCAPTCHA_KEY && det.sitekey && (det.type === 'turnstile' || det.type === 'recaptcha')) {
      const token = await solveWith2Captcha(det, page.url()).catch(() => null);
      if (token) { await injectToken(page, token); await page.waitForTimeout(800); return { ok: true, note: '2captcha-' + det.type }; }
    }
    await page.waitForTimeout(2500);
    return { ok: true, note: (await isSolved(scope)) ? 'auto-passed' : 'invisible-proceed' };
  }

  // Interactive challenge. Try a paid solver first if configured.
  if (process.env.TWOCAPTCHA_KEY) {
    const token = await solveWith2Captcha(det, page.url()).catch(() => null);
    if (token) { await injectToken(page, token); await page.waitForTimeout(800); return { ok: true, note: '2captcha-solved' }; }
  }

  // Unattended runs: do NOT block for a human (would hang ~180s per challenge).
  // Bail fast unless CAPTCHA_HITL is explicitly set (attended mode).
  if (!process.env.CAPTCHA_HITL) {
    return { ok: false, note: 'interactive-captcha-skip' };
  }

  // Human-in-the-loop: the window is visible — ask the user to solve it.
  console.log(`\n⚠️  Interactive ${det.type || 'captcha'} challenge — please solve it in the browser window now. Waiting up to ${Math.round(timeoutMs / 1000)}s...`);
  try { await page.bringToFront(); } catch {}
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isSolved(scope)) { console.log('   captcha solved — continuing.'); return { ok: true, note: 'human-solved' }; }
    // also break if the challenge frame disappeared (some auto-resolve)
    const d2 = await detectCaptcha(scope);
    if (!d2.interactive && !d2.present) return { ok: true, note: 'challenge-cleared' };
    await page.waitForTimeout(2500);
  }
  return { ok: false, note: 'captcha-timeout' };
}

module.exports = { detectCaptcha, isSolved, handleCaptcha };
