// Workable ATS handler — form lives at <listing>/apply/.
// Fields: firstname/lastname/email/phone + REQUIRED address/city/postcode/country,
// optional headline/summary/cover_letter, resume file, and custom questions:
//   - input_QA_<id>_input  → custom dropdown (role=combobox)
//   - QA_<id> textarea      → essay
//   - QA_<id> radios        → Yes/No
// Workable usually finalizes on submit; some accounts then email a verification
// code, which we retrieve from Gmail and enter.
const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { pickFirstSuggestion } = require('../util/location');
const { optionForLabel } = require('../util/answers-map');
const { handleCaptcha } = require('../util/captcha');
const { labelOf, fillTextByLabel, handleRadioGroups, handleNativeSelects, fillRemainingRequired, proofread, dryRunStop, confirmAfterSubmit, handleEmailVerification } = require('../util/form');

const STD = /^(firstname|lastname|email|phone|headline|summary|cover_letter|address|city|postcode|country)$/i;

async function applyWorkable(page, jobMeta) {
  let url = page.url();
  if (!/\/apply\/?$/.test(url)) {
    const headText = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (/\bIndia\b|\bLATAM\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bSouth Africa\b|\bUkraine\b|\bPhilippines\b/i.test(headText)
        && !/United States|US Remote|North America|Americas|Anywhere/i.test(headText)) {
      return { status: 'Skipped', reason: 'Non-US location' };
    }
    await page.goto(url.replace(/\/$/, '') + '/apply/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  await dismissCookies(page);
  await page.waitForSelector('input[name="firstname"]', { timeout: 15000 }).catch(() => {});

  // ── Standard fields ──
  const fill = async (sel, val) => { const e = await page.$(sel); if (e && !(await e.inputValue().catch(() => ''))) await e.fill(val).catch(() => {}); };
  await fill('input[name="firstname"]', a.firstName);
  await fill('input[name="lastname"]', a.lastName);
  await fill('input[name="email"]', a.email);
  await fill('input[name="phone"]', a.phoneFull);
  await fill('input[name="headline"]', a.currentTitle);
  await fill('input[name="city"]', a.city);
  await fill('input[name="postcode"]', a.zip || '77002');
  await fill('input[name="country"]', a.country);

  // ── Resume upload — use the file input DIRECTLY. Do NOT click "Import resume
  // from": that triggers Workable's autofill (?autofill) flow which leaves the
  // form in a state where the React submit silently no-ops.
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) { await fileInput.setInputFiles(a.resumePath).catch(() => {}); await page.waitForTimeout(2500); }

  // ── Address (Google Places autocomplete) ──
  const addr = await page.$('input[name="address"]');
  if (addr && !(await addr.inputValue().catch(() => ''))) {
    await addr.click().catch(() => {});
    await page.keyboard.type(a.fullAddress, { delay: 35 }).catch(() => {});
    await page.waitForTimeout(1200);
    if (!(await pickFirstSuggestion(page))) {
      await page.keyboard.press('ArrowDown').catch(() => {});
      await page.keyboard.press('Enter').catch(() => {});
    }
    // ensure it isn't left blank
    if (!(await addr.inputValue().catch(() => ''))) await addr.fill(a.fullAddress).catch(() => {});
  }

  // ── Custom dropdowns (role=combobox) ──
  for (const cb of await page.$$('input[role="combobox"]')) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.inputValue().catch(() => '')) continue;
    await fillWorkableCombobox(page, cb);
  }

  // ── Essays / open text (textarea) ──
  for (const t of await page.$$('textarea:not([name="g-recaptcha-response"])')) {
    const name = await t.getAttribute('name').catch(() => '') || '';
    if (/summary|cover_letter/i.test(name)) continue; // optional
    if (!(await t.isVisible().catch(() => false))) continue;
    if (await t.inputValue().catch(() => '')) continue;
    const label = await labelOf(t);
    const ans = generateAnswer(label, a);
    if (ans) await t.fill(ans).catch(() => {});
  }

  // ── Any other custom text inputs by label ──
  await fillTextByLabel(page, { skip: STD });

  // ── Radios + native selects + EEO ──
  await handleRadioGroups(page);
  await handleNativeSelects(page);

  // ── Safety net: fill any remaining required field a custom question missed ──
  await fillRemainingRequired(page);
  await proofread(page).catch(() => {});

  // ── Captcha ──
  await handleCaptcha(page, page).catch(() => {});

  const dry = await dryRunStop(page, jobMeta && jobMeta.company, await unfilledNote(page));
  if (dry) return dry;

  await dismissCookies(page);
  // ── Submit ──
  const submitBtn = await page.$('button[type="submit"]:has-text("Submit"), button:has-text("Submit application")');
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found' };
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /Submit application/i.test(x.innerText)); b?.click(); });
  });

  // Email verification code (Workable sometimes requires it post-submit).
  await handleEmailVerification(page.context(), page).catch(() => {});

  if (page.url().includes('?success') ||
      await confirmAfterSubmit(page, page, { re: /thank you|application (received|submitted)|successfully submitted|we will be in touch|application has been submitted/i, urlRe: /\?success|\/success|\/thanks/i, rounds: 16, waitMs: 2500 })) {
    return { status: 'Applied', reason: '—' };
  }
  // Some Workable tenants gate the submit behind Cloudflare Turnstile (managed/
  // invisible). The button sticks on "Submitting…" while Turnstile silently scores
  // the session; a bot-flagged session never gets a token, so it hangs. There is
  // no challenge to click — honest report (escalate via TWOCAPTCHA_KEY or a warmer
  // logged-in profile).
  const stuck = await page.evaluate(() => {
    const submitting = [...document.querySelectorAll('button')].some((b) => /submitting/i.test(b.innerText));
    const cf = [...document.querySelectorAll('iframe,script')].some((e) => /challenges\.cloudflare\.com/i.test(e.src || ''));
    return { submitting, cf };
  }).catch(() => ({}));
  if (stuck.submitting || stuck.cf) {
    return { status: 'Error', reason: 'Blocked by Cloudflare Turnstile anti-bot (submission gated; set TWOCAPTCHA_KEY or submit this one manually)' };
  }
  // Ignore Workable's "Autofill completed! Please review" banner (a [role=alert]
  // notice, not an error). Report only genuine field validation errors.
  const errs = await page.$$eval('[class*="error"], [role="alert"]', els => els.map(e => (e.innerText || '').trim())
    .filter(t => t && !/autofill|please review/i.test(t)).slice(0, 3).join(' | ').slice(0, 200)).catch(() => '');
  return { status: 'Error', reason: errs ? 'Validation: ' + errs : 'No confirmation detected (Workable)' };
}

// Fill a Workable custom dropdown: click to open, pick the option matching our
// answer for the question label.
async function fillWorkableCombobox(page, cb) {
  // Workable puts the question text in the element BEFORE the dropdown's wrapping
  // <label> (e.g. "*\nIn what state do you currently reside?").
  const label = await cb.evaluate((el) => {
    const wrap = el.closest('label');
    const prev = wrap && wrap.parentElement && wrap.parentElement.previousElementSibling;
    let txt = (prev && prev.innerText) || (wrap && wrap.innerText) || '';
    return txt.replace(/select an option.*/is, '').replace(/\(optional\)/ig, '').replace(/\*/g, '').trim().slice(0, 200);
  }).catch(() => '');

  await cb.scrollIntoViewIfNeeded().catch(() => {});
  await cb.click().catch(() => {});
  await page.waitForTimeout(450);
  let opts = await readOpenOptions(page);

  // Searchable dropdowns show no options until you type — seed from the question.
  if (!opts.length) {
    const seed = searchSeed(label);
    if (seed) { await cb.type(seed, { delay: 35 }).catch(() => {}); await page.waitForTimeout(700); opts = await readOpenOptions(page); }
  }
  if (!opts.length) { await cb.click().catch(() => {}); await page.waitForTimeout(450); opts = await readOpenOptions(page); }
  if (!opts.length) { await page.keyboard.press('Escape').catch(() => {}); return; }

  const pick = optionForLabel(label, opts, a) || (opts.length === 1 ? opts[0] : opts.find((o) => /^yes\b/i.test(o))) || null;
  if (!pick) { await page.keyboard.press('Escape').catch(() => {}); return; }
  const chose = await page.evaluate((p) => {
    const els = Array.from(document.querySelectorAll('[role="option"], li[role="option"], ul[role="listbox"] li, [id*="option"]')).filter((e) => e.offsetParent !== null);
    const hit = els.find((e) => e.textContent.trim().toLowerCase() === p.toLowerCase()) || els.find((e) => e.textContent.trim().toLowerCase().includes(p.toLowerCase()));
    if (hit) { hit.scrollIntoView({ block: 'center' }); hit.click(); return true; }
    return false;
  }, pick).catch(() => false);
  if (!chose) { await page.keyboard.press('Enter').catch(() => {}); }
  await page.waitForTimeout(250);
}

// What to type into a searchable dropdown to surface its options.
function searchSeed(label) {
  const L = (label || '').toLowerCase();
  if (/state|province/.test(L)) return a.stateFull;
  if (/country/.test(L)) return a.country;
  if (/city/.test(L)) return a.city;
  return null;
}

async function readOpenOptions(page) {
  return page.$$eval('[role="option"], li[role="option"], ul[role="listbox"] li, [id*="option"]', (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()).filter(Boolean)).catch(() => []);
}

async function dismissCookies(page) {
  for (const txt of ['Accept all', 'Accept All', 'Accept', 'Got it', 'I agree', 'Allow all']) {
    const btn = await page.$(`button:has-text("${txt}")`).catch(() => null);
    if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(400); break; }
  }
}

async function unfilledNote(page) {
  const empty = await page.$$eval('input[required], textarea[required], input[aria-required="true"]', (els) =>
    els.filter((e) => e.offsetParent !== null && !e.value && e.type !== 'file').map((e) => (e.name || e.id || '').slice(0, 30))).catch(() => []);
  return empty.length ? ('UNFILLED REQUIRED: ' + empty.slice(0, 8).join(' | ')) : 'all required filled';
}

module.exports = { applyWorkable };
