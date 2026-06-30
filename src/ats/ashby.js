// Ashby ATS handler — uses shared utils (answers-map, location, captcha, form).
// Ashby forms: system fields (_systemfield_name/email/resume) + UUID-named custom
// fields (text/textarea), radio groups for Yes/No, occasional custom dropdowns,
// and an INVISIBLE reCAPTCHA (auto-passes in real Chrome).
const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { textValueForLabel } = require('../util/answers-map');
const { fillLocation } = require('../util/location');
const { handleCaptcha } = require('../util/captcha');
const { labelOf, handleRadioGroups, handleNativeSelects, fillRemainingRequired, proofread, dryRunStop, confirmAfterSubmit, handleEmailVerification } = require('../util/form');

async function applyAshby(page, jobMeta) {
  let url = page.url();
  if (!/\/application\b/.test(url)) {
    await page.goto(url.replace(/\/$/, '') + '/application', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await page.waitForSelector('input#_systemfield_name, input[name="_systemfield_name"]', { timeout: 15000 }).catch(() => {});

  // Pre-flight eligibility from page text.
  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
  if (/\bIndia\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bPeru\b|\bBrazil\b|\bSouth Africa\b|\bLithuania\b|\bUkraine\b|\bPhilippines\b|\bVilnius\b|\bBerlin\b|\bGermany\b|\bLondon\b|\bUnited Kingdom\b|\bEMEA\b/i.test(pageText)
      && !/United States|US Remote|Americas|North America|Remote, US|Remote \(US/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Non-US location' };
  }
  if (/US Citizen(?:ship)?\s+required|active\s+(secret|TS\/SCI|clearance)/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Requires US citizenship or active clearance' };
  }

  // ── Resume upload (autofills name/email on Ashby) ──
  const uploadBtn = await page.$('button:has-text("Upload file")');
  if (uploadBtn) {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser').catch(() => null), uploadBtn.click().catch(() => {})]);
    if (chooser) { await chooser.setFiles(a.resumePath).catch(() => {}); await page.waitForTimeout(3000); }
  }
  await page.locator('input#_systemfield_resume').setInputFiles(a.resumePath).catch(() => {});
  await page.waitForTimeout(800);

  // ── System fields ──
  await page.locator('input#_systemfield_name').fill(a.fullName).catch(() => {});
  await page.locator('input#_systemfield_email').fill(a.email).catch(() => {});
  // Phone (number or tel input).
  for (const sel of ['input[type="tel"]', 'input[type="number"]']) {
    const p = await page.$(sel);
    if (p && !(await p.inputValue().catch(() => ''))) { await p.fill(a.phoneDigits).catch(() => {}); break; }
  }

  // ── Location (Ashby uses a text/autocomplete field labeled "Location") ──
  await fillLocation(page, page, a).catch(() => {});

  // ── Custom text inputs (UUID names) by label ──
  for (const inp of await page.$$('input[type="text"]')) {
    if (!(await inp.isVisible().catch(() => false))) continue;
    if (await inp.inputValue().catch(() => '')) continue;
    const label = await labelOf(inp);
    if (/location|where.*(based|located)/i.test(label)) continue; // handled by fillLocation
    // Yes/No questions sometimes render as a text field on Ashby → answer literally.
    const val = textValueForLabel(label, a);
    if (val) { await inp.fill(String(val).slice(0, 500)).catch(() => {}); continue; }
    if (/authoriz|eligible to work|legally/i.test(label)) await inp.fill('Yes').catch(() => {});
    else if (/sponsor/i.test(label)) await inp.fill('No').catch(() => {});
    else if (/hybrid|onsite|in.?office|open to working/i.test(label)) await inp.fill('Yes').catch(() => {});
  }

  // ── Essays / open-text (textarea) by label ──
  for (const t of await page.$$('textarea')) {
    const name = await t.getAttribute('name').catch(() => '');
    if (name === 'g-recaptcha-response') continue;
    if (!(await t.isVisible().catch(() => false))) continue;
    if (await t.inputValue().catch(() => '')) continue;
    const label = await labelOf(t);
    if (/cover letter|additional information/i.test(label) && !/\*/.test(label)) continue;
    const ans = generateAnswer(label, a);
    if (ans) await t.fill(ans).catch(() => {});
  }

  // ── Radio groups (sponsorship, EEO, Yes/No) ──
  await handleRadioGroups(page);

  // ── Ashby custom dropdowns / Yes-No <button> toggles ──
  await handleAshbyButtons(page);
  await handleAshbyDropdowns(page);
  await handleNativeSelects(page);

  // ── Safety net: fill any remaining required field a custom question missed ──
  await fillRemainingRequired(page);
  await proofread(page).catch(() => {});

  // ── Captcha (invisible reCAPTCHA → auto-pass) ──
  await handleCaptcha(page, page).catch(() => {});

  const dry = await dryRunStop(page, jobMeta && jobMeta.company, await unfilledNote(page));
  if (dry) return dry;

  // ── Submit ──
  const submitBtn = await page.$('button:has-text("Submit Application"), button:has-text("Submit application"), button[type="submit"]');
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found' };
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Submit Application/i.test(x.innerText)); b?.click(); });
  });

  // Some Ashby flows email a verification code before finalizing.
  const ctx = page.context();
  await handleEmailVerification(ctx, page).catch(() => {});

  // Bail FAST on a validation error (Ashby shows "needs corrections" within ~3s)
  // instead of waiting out the full reCAPTCHA confirm window.
  await page.waitForTimeout(3000);
  const earlyErr = await page.$$eval('[role="alert"], [class*="error"]', els =>
    els.map(e => (e.innerText || '').trim()).find(t => /needs corrections|missing entry|required field|please (correct|complete|enter)/i.test(t)) || '').catch(() => '');
  if (earlyErr) return { status: 'Error', reason: 'Validation: ' + earlyErr.replace(/\s+/g, ' ').slice(0, 150) };

  // No validation error → wait for the success state (invisible reCAPTCHA can take ~30s).
  if (await confirmAfterSubmit(page, page, {
    re: /your application.*(was )?(successfully )?submitted|application (was )?(successfully )?(submitted|received)|we will (be in touch|review your application|contact you)|thank you for applying/i,
    rounds: 14, waitMs: 2500,
  })) {
    return { status: 'Applied', reason: '—' };
  }
  const errors = await page.$$eval('[role="alert"], [class*="error"]', els => els.map(e => e.innerText).filter(Boolean).join(' | ').slice(0, 200)).catch(() => '');
  return { status: 'Error', reason: errors ? 'Validation: ' + errors : 'No success message detected' };
}

// Ashby Yes/No rendered as <button> pairs inside a question container.
async function handleAshbyButtons(page) {
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = (await btn.innerText().catch(() => '')).trim();
    if (!/^(yes|no)$/i.test(text)) continue;
    const qLabel = await btn.evaluate((el) => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) { const l = p.querySelector('label, legend, [class*="label"]')?.innerText; if (l && !/^(yes|no)$/i.test(l.trim())) return l.trim().slice(0, 200); p = p.parentElement; }
      return '';
    }).catch(() => '');
    if (!qLabel) continue;
    const { yesNoForLabel } = require('../util/answers-map');
    // Unknown custom screening question → default Yes (sponsorship/criminal/etc.
    // are recognized and answered No by yesNoForLabel before this).
    const want = yesNoForLabel(qLabel, a) || 'Yes';
    if (want.toLowerCase() === text.toLowerCase()) {
      // Only click if this Yes/No pair isn't already answered (avoid toggling off).
      const answered = await btn.evaluate((el) => {
        const grp = el.closest('fieldset, div');
        return grp ? !!grp.querySelector('[aria-pressed="true"], [aria-checked="true"], [data-selected="true"], .selected') : false;
      }).catch(() => false);
      if (!answered) await btn.click().catch(() => {});
    }
  }
}

// Ashby searchable dropdowns (input[role="combobox"], placeholder "Start typing…")
// for non-location single-select fields (state, languages, etc.). Type a seed and
// pick the best option.
async function handleAshbyDropdowns(page) {
  const { optionForLabel } = require('../util/answers-map');
  for (const cb of await page.$$('input[role="combobox"]')) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.inputValue().catch(() => '')) continue;
    const label = await labelOf(cb);
    if (/location|where.*(based|located)|city/i.test(label)) continue; // handled by fillLocation
    // seed: state→Texas, language→English, else open and read options
    let seed = '';
    if (/state|province/i.test(label)) seed = a.stateFull;
    else if (/language/i.test(label)) seed = 'English';
    else if (/country/i.test(label)) seed = 'United States';
    await cb.scrollIntoViewIfNeeded().catch(() => {});
    await cb.click().catch(() => {});
    await page.waitForTimeout(300);
    if (seed) { await cb.type(seed, { delay: 30 }).catch(() => {}); await page.waitForTimeout(500); }
    let opts = await page.$$eval('[role="option"], li[role="option"], [class*="option"]', (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).filter(Boolean)).catch(() => []);
    if (!opts.length) { await page.keyboard.press('Escape').catch(() => {}); continue; }
    const pick = optionForLabel(label, opts, a) || (seed && opts.find((o) => new RegExp(seed, 'i').test(o))) || (opts.length === 1 ? opts[0] : null);
    if (!pick) { await page.keyboard.press('Escape').catch(() => {}); continue; }
    const chose = await page.evaluate((p) => {
      const els = Array.from(document.querySelectorAll('[role="option"], li[role="option"], [class*="option"]')).filter((e) => e.offsetParent !== null);
      const hit = els.find((e) => e.textContent.trim().toLowerCase() === p.toLowerCase()) || els.find((e) => e.textContent.trim().toLowerCase().includes(p.toLowerCase()));
      if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return true; }
      return false;
    }, pick).catch(() => false);
    if (!chose) await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(200);
  }
}

// Diagnostic note for DRY_RUN: list required fields still empty.
async function unfilledNote(page) {
  const empty = await page.$$eval('input[required], textarea[required], input[aria-required="true"]', (els) =>
    els.filter((e) => e.offsetParent !== null && !e.value && e.type !== 'file').map((e) => (e.getAttribute('aria-label') || e.name || e.id || '').slice(0, 40))).catch(() => []);
  return empty.length ? ('UNFILLED REQUIRED: ' + empty.slice(0, 6).join(' | ')) : 'all required filled';
}

module.exports = { applyAshby };
