// Lever ATS handler — uses shared utils. Lever forms: name/email/phone/org +
// urls[...] + location autocomplete + resume + custom question cards + native
// EEO selects, wrapped in a PASSIVE hCaptcha "enclave" (scores the session
// silently; passes in real Chrome — see util/captcha.js).
const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { fillLocation } = require('../util/location');
const { handleCaptcha } = require('../util/captcha');
const { labelOf, fillTextByLabel, handleRadioGroups, handleNativeSelects, fillRemainingRequired, proofread, dryRunStop, confirmAfterSubmit, handleEmailVerification } = require('../util/form');
const { attachResume } = require('../resume/upload');
const { gateBeforeSubmit } = require('../util/answer-review');

const STD = /^(name|email|phone|org|urls|resume|location|comments)/;

const trace = require("../util/trace");
async function applyLever(page, jobMeta) {
  trace.stage("lever");
  const url = page.url();
  if (!/\/apply(\/|$)/.test(url)) {
    await page.goto(url.replace(/\/$/, '') + '/apply', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Pre-flight: skip non-US / citizenship-required (e.g. defense/ITAR) roles.
  const headText = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bLATAM\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bCanada\b(?!.*US)|\bUkraine\b|\bPhilippines\b|\bGermany\b|\bLondon\b|\bUnited Kingdom\b|\bEMEA\b|\bEurope\b/i.test(headText)
      && !/United States|US Remote|North America|Americas/i.test(headText)) {
    return { status: 'Skipped', reason: 'Non-US location' };
  }
  if (/US Citizen(?:ship)?\s+(is\s+)?required|must be a US citizen|active\s+(secret|TS\/SCI|clearance)|ITAR/i.test(headText) && a.usCitizen !== 'Yes') {
    return { status: 'Skipped', reason: 'Requires US citizenship / clearance (ITAR)' };
  }

  await dismissCookies(page);

  // ── Resume ──
  // Lever's passive hCaptcha scores the session, so a silently missing attachment
  // here produced a form that looked submitted and arrived empty. attachResume
  // confirms the input actually holds the file before the run continues.
  trace.stage("lever:resume");
  const up = await attachResume(page, page, a.resumePath, {
    selectors: ['input[name="resume"][type="file"]', 'input[type="file"]'],
    buttonTexts: [],
    settleMs: 1800,
  });
  if (!up.ok) return up.result;

  // ── Standard fields ──
  const fill = async (sel, val) => { const e = await page.$(sel); if (e && val && !(await e.inputValue().catch(() => ''))) await e.fill(val).catch(() => {}); };
  await fill('input[name="name"]', a.fullName);
  await fill('input[name="email"]', a.email);
  await fill('input[name="phone"]', a.phoneFull);
  await fill('input[name="org"]', a.currentEmployer);
  await fill('input[name="urls[LinkedIn]"]', a.linkedIn);
  await fill('input[name="urls[Portfolio]"]', a.portfolio);
  await fill('input[name="urls[GitHub]"]', a.github);

  // ── Location ──
  // Lever uses a Google Places field (visible `location`) backed by a hidden
  // `selectedLocation`, which its validation actually checks. Places suggestions
  // don't reliably load under automation, so set BOTH directly via the native
  // setter, then still try the autocomplete in case it's a plain field.
  await page.evaluate((val) => {
    const setNative = (sel, v) => {
      const i = document.querySelector(sel); if (!i) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, v);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setNative('input[name="location"]', val);
    setNative('input[name="selectedLocation"], #selected-location', val);
  }, a.fullAddress).catch(() => {});
  await page.waitForTimeout(400);
  if (!(await page.$eval('input[name="location"]', (e) => e.value).catch(() => ''))) {
    await fillLocation(page, page, a).catch(() => {});
  }

  // ── Custom question cards: textareas + short-answer inputs by label ──
  for (const t of await page.$$('textarea')) {
    if (!(await t.isVisible().catch(() => false))) continue;
    if (await t.inputValue().catch(() => '')) continue;
    const label = await labelOf(t);
    if (/cover letter|additional information/i.test(label) && !/\*/.test(label)) continue;
    const ans = generateAnswer(label, a);
    if (ans) await t.fill(ans).catch(() => {});
  }
  await fillTextByLabel(page, { skip: STD });

  // ── Radios + native selects (work auth Yes/No, EEO gender/race/veteran/disability) ──
  await handleRadioGroups(page);
  await handleNativeSelects(page);

  // ── Safety net: fill any remaining required field a custom question missed ──
  await fillRemainingRequired(page);
  await proofread(page).catch(() => {});

  // ── Captcha (passive hCaptcha enclave → auto-pass; HITL if a challenge shows) ──
  await handleCaptcha(page, page).catch(() => {});


  // ── Pre-submit review: ground every answer against the persona ──────────
  //
  // The last look before an irreversible action. Reads the filled form back out of the
  // DOM and checks it against the persona: identity fields deterministically (always),
  // then a model review of every answer when one is reachable. A finding it can ground is
  // corrected in place; one it cannot blocks the submit and raises an attention item, so
  // the job stays actionable rather than being sent wrong.
  //
  // Before the dry-run stop on purpose: a dry run should exercise the review too, which is
  // how the quality is inspectable before anything goes live.
  trace.stage("lever:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: a, jobMeta });
  if (reviewBlock) return reviewBlock;

  const dry = await dryRunStop(page, jobMeta && jobMeta.company, await unfilledNote(page));
  if (dry) return dry;

  // ── Submit ──
  // Lever's submit is a <button type="button"> labelled "SUBMIT APPLICATION".
  // Match it by TEXT (not type=submit, which also matches the cookie "dismiss"
  // button that appears earlier in the DOM).
  const submitBtn = await page.$('button:has-text("Submit application"), button:has-text("SUBMIT APPLICATION")');
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found' };
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(x => /submit application/i.test(x.innerText)); b?.click(); });
  });

  // A code we cannot get means the form is still sitting on the code field, unsubmitted.
  // Skip with an attention item rather than reporting a confirmation failure for a job
  // that is only waiting on a code.
  const verify = await handleEmailVerification(page.context(), page, page, jobMeta).catch(() => ({ needed: false }));
  if (verify.needed && !verify.ok) return { status: 'Skipped', reason: verify.reason, attention: verify.attention };

  trace.stage("lever:confirm");
  if (await confirmAfterSubmit(page, page, { urlRe: /\/thanks|\/confirmation|\/success/i, re: /thank you|application submitted|successfully submitted|received your application/i })) {
    return { status: 'Applied', reason: '—' };
  }
  // If an interactive captcha is still blocking, say so honestly.
  const cap = await page.$('iframe[src*="hcaptcha.com/captcha"]').catch(() => null);
  if (cap && await cap.isVisible().catch(() => false)) return { status: 'Error', reason: 'Blocked by hCaptcha challenge (needs manual solve)' };
  const err = await page.$$eval('.application-question.error, [aria-invalid="true"], .form-field-error', els => els.map(e => e.innerText).filter(Boolean).join(' | ').slice(0, 160)).catch(() => '');
  if (err) return { status: 'Error', reason: 'Validation: ' + err };
  // Fallback: if submit button is gone and no errors, the app went through
  const btnGone = await page.$('button:has-text("Submit application"), button[type="submit"]').catch(() => null);
  const btnVisible = btnGone ? await btnGone.isVisible().catch(() => false) : false;
  if (!btnVisible) return { status: 'Applied', reason: 'submit button gone (no explicit confirmation page)' };
  return { status: 'Error', reason: 'No confirmation after submit' };
}

async function dismissCookies(page) {
  for (const txt of ['Accept', 'Accept all', 'I agree', 'Got it']) {
    const btn = await page.$(`button:has-text("${txt}")`).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await page.waitForTimeout(400); break; }
  }
}

async function unfilledNote(page) {
  const empty = await page.$$eval('input[required], textarea[required]', (els) =>
    els.filter((e) => e.offsetParent !== null && !e.value && e.type !== 'file').map((e) => (e.name || e.id || '').slice(0, 30))).catch(() => []);
  return empty.length ? ('UNFILLED REQUIRED: ' + empty.slice(0, 8).join(' | ')) : 'all required filled';
}

module.exports = { applyLever };
