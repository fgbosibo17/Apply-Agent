// SmartRecruiters handler — best-effort. SmartRecruiters apply is an SPA reached
// via an "I'm interested" / "Apply" button. Standard fields: firstName, lastName,
// email, phoneNumber, location, resume, consent, plus screening questions.
//
// IMPORTANT: many enterprise SmartRecruiters tenants front the form with DataDome
// bot-protection (captcha-delivery.com). DataDome cannot be auto-solved; when it
// shows a challenge we fall back to human-in-the-loop (handleCaptcha), since the
// runner's browser is visible. Passive DataDome passes silently in real Chrome.
const a = require('../answers');
const { fillLocation } = require('../util/location');
const { handleCaptcha, detectCaptcha } = require('../util/captcha');
const { fillTextByLabel, handleRadioGroups, handleNativeSelects, fillRemainingRequired, proofread, dryRunStop, confirmAfterSubmit } = require('../util/form');
const { attachResume } = require('../resume/upload');
const trace = require("../util/trace");
const { gateBeforeSubmit } = require('../util/answer-review');

const STD = /firstName|lastName|^email$|phoneNumber|phone/i;

async function applySmartrecruiters(page, jobMeta) {
  await page.waitForTimeout(1500);
  await dismissCookies(page);

  // DataDome interstitial up front? DataDome is NOT a captcha we can solve. In an
  // unattended batch run, bail FAST rather than blocking on a 180s human-in-the-
  // loop wait. Set SR_HITL=1 to enable the manual-solve pause (attended runs).
  let cap = await detectCaptcha(page);
  if (cap.present && cap.type === 'datadome') {
    if (!process.env.SR_HITL) return { status: 'Skipped', reason: 'SmartRecruiters DataDome (anti-bot) — skipped (set SR_HITL=1 to solve manually)' };
    const r = await handleCaptcha(page, page, { timeoutMs: 180000 });
    if (!r.ok) return { status: 'Error', reason: 'Blocked by DataDome (manual solve timed out)' };
    await page.waitForTimeout(1500);
  }

  // Reveal the application form.
  //
  // The posting page is not the application. SmartRecruiters serves the form from a
  // separate oneclick-ui URL, and the anchor pointing there opens in a new tab - so
  // clicking it left this page on the job description, with no file input and no name
  // field. That is why every SmartRecruiters job failed with no upload control found.
  // Read the href and navigate to it, which also sidesteps the cookie banner eating
  // the click.
  const oneclick = await page.evaluate(() => {
    const all = [...document.querySelectorAll(`a[href*="oneclick-ui"]`)].map((e) => e.getAttribute(`href`) || ``);
    return all.find((h) => h.includes(`jobs.smartrecruiters.com`)) || all.find((h) => h.startsWith(`/`)) || all[0] || null;
  }).catch(() => null);

  if (oneclick) {
    trace.stage("smartrecruiters:oneclick");
    console.log(`    [smartrecruiters] opening the application form directly`);
    await page.goto(oneclick, { waitUntil: `domcontentloaded`, timeout: 45000 }).catch(() => {});
    // The form is an SPA - the fields and the file input arrive a beat after load.
    await page.waitForSelector(`input[type="file"], input[name="firstName"]`, { timeout: 20000 }).catch(() => {});
    await dismissCookies(page);

    // Re-check for DataDome HERE, not only on the posting page.
    //
    // The posting page is static and passes clean; the oneclick form is the thing
    // DataDome actually guards. A blocked form renders as an empty document - no
    // fields, no file input - so the run reported it as no upload control found and
    // burned the job. It is a bot-block, so report it as one and leave the job
    // retryable instead of spending an application slot on it.
    const capForm = await detectCaptcha(page);
    if (capForm.present && capForm.type === `datadome`) {
      if (!process.env.SR_HITL) return { status: `Skipped`, reason: `SmartRecruiters DataDome on the application form - skipped (set SR_HITL=1 to solve manually)` };
      const rr = await handleCaptcha(page, page, { timeoutMs: 180000 });
      if (!rr.ok) return { status: `Error`, reason: `Blocked by DataDome on the application form` };
      await page.waitForTimeout(1500);
    }
  }

  // Fall back to the old reveal-by-click path only when no direct link was present.
  if (!oneclick)
  for (const t of ["I'm interested", 'Apply now', 'Apply', 'Apply for this job']) {
    const b = await page.$(`a:has-text("${t}"), button:has-text("${t}")`).catch(() => null);
    if (b && await b.isVisible().catch(() => false)) { await b.click().catch(() => {}); await page.waitForTimeout(2500); break; }
  }
  await dismissCookies(page);
  await page.waitForTimeout(1000);

  // Eligibility pre-flight.
  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
  if (/\bIndia\b|\bGermany\b|\bUnited Kingdom\b|\bEMEA\b|\bcitizenship required\b/i.test(pageText) && !/United States|US Remote|Americas/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Non-US / citizenship-restricted' };
  }

  // Standard fields (SmartRecruiters uses camelCase names).
  const fill = async (sel, val) => { const e = await page.$(sel); if (e && val && !(await e.inputValue().catch(() => ''))) await e.fill(val).catch(() => {}); };
  await fill('input[name="firstName"], input[id*="firstName" i]', a.firstName);
  await fill('input[name="lastName"], input[id*="lastName" i]', a.lastName);
  await fill('input[name="email"], input[type="email"]', a.email);
  await fill('input[name="phoneNumber"], input[type="tel"], input[id*="phone" i]', a.phoneFull);

  // Resume upload. SmartRecruiters moves the file into its own store and clears the
  // input, so confirmation leans on the filename in the widget. Previously both the
  // chooser and the direct-input attempt ended in `.catch(() => {})` and the
  // application submitted regardless; now it stops.
    trace.stage("smartrecruiters:resume");
  const up = await attachResume(page, page, a.resumePath, {
    buttonSelectors: ['[data-test="resume-upload"] button'],
    buttonTexts: ['Upload', 'Choose'],
    settleMs: 2500,
  });
  if (!up.ok) return up.result;

  // Location, custom text, radios, selects.
  await fillLocation(page, page, a).catch(() => {});
  await fillTextByLabel(page, { skip: STD });
  await handleRadioGroups(page);
  await handleNativeSelects(page);

  // Consent checkboxes (data processing / privacy) — required to submit.
  for (const cb of await page.$$('input[type="checkbox"]')) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;
    const label = await cb.evaluate((e) => (e.closest('label')?.innerText || e.parentElement?.innerText || '').slice(0, 120)).catch(() => '');
    if (/consent|agree|privacy|terms|process my|gdpr|acknowledge/i.test(label)) await cb.check({ timeout: 3000 }).catch(() => cb.click().catch(() => {}));
  }

  // Safety net + captcha (DataDome / other) before submit.
  await fillRemainingRequired(page);
  await proofread(page).catch(() => {});
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
  trace.stage("smartrecruiters:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: a, jobMeta });
  if (reviewBlock) return reviewBlock;

  const dry = await dryRunStop(page, jobMeta && jobMeta.company, 'filled (SmartRecruiters)');
  if (dry) return dry;

  // Submit.
  const submitBtn = await page.$('button:has-text("Send application"), button:has-text("Submit"), button:has-text("Apply"), button[type="submit"]');
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found (DataDome may have blocked the form)' };
  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await submitBtn.click({ timeout: 10000 }).catch(() => {});

  trace.stage("smartrecruiters:confirm");
  if (await confirmAfterSubmit(page, page, { re: /thank you|application (sent|received|submitted)|successfully|we received your/i, urlRe: /thank|success|confirmation/i })) {
    return { status: 'Applied', reason: '—' };
  }
  cap = await detectCaptcha(page);
  if (cap.present && cap.type === 'datadome') return { status: 'Error', reason: 'DataDome challenge blocked submission' };
  return { status: 'Error', reason: 'No confirmation (SmartRecruiters)' };
}

async function dismissCookies(page) {
  for (const txt of ['Accept All', 'Accept all', 'Accept', 'I agree', 'Got it', 'Allow all']) {
    const btn = await page.$(`button:has-text("${txt}")`).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false)) { await btn.click().catch(() => {}); await page.waitForTimeout(400); break; }
  }
}

module.exports = { applySmartrecruiters };
