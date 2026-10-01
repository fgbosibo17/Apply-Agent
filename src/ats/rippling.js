// Rippling ATS handler.
// Rippling career pages: ats.rippling.com/<company>/jobs/<uuid>
// Clean modern form — no account creation needed, direct submit.
//
// Flow:
//   1. Navigate to job URL
//   2. Click "Apply" if needed
//   3. Fill basic info: name, email, phone
//   4. Upload resume
//   5. Fill any custom questions
//   6. Submit and confirm

const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { fillRemainingRequired, handleRadioGroups, dryRunShotPath } = require('../util/form');
const { attachResume } = require('../resume/upload');
const { gateBeforeSubmit } = require('../util/answer-review');
const { yesNoForLabel } = require('../util/answers-map');

const trace = require("../util/trace");
async function applyRippling(page, jobMeta) {
  trace.stage("rippling");
  console.log('    [rippling] starting application…');
  await page.waitForTimeout(2000);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');

  // Location check
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bLATAM\b/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Non-US location detected' };
  }
  // A clearance is skipped for everyone; citizenship / export control only when the
  // persona is not a US citizen (`usCitizen` in src/personas.js).
  if (/security clearance/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Requires a security clearance' };
  }
  if (a.usCitizen !== 'Yes' && /US citizenship required|must be a US citizen|ITAR|export control/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Requires US citizenship / export-control eligibility' };
  }

  // Click Apply button
  const applyBtn = await page.$('button:has-text("Apply"), a:has-text("Apply"), button:has-text("Apply Now"), a:has-text("Apply Now")').catch(() => null);
  if (applyBtn) {
    await applyBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Wait for form fields
  await page.waitForSelector('input[type="text"], input[type="email"], input[name*="first" i]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && val) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const cur = await el.inputValue().catch(() => '');
      if (!cur) await el.fill(String(val)).catch(() => {});
    }
  };

  // Fill by label — Rippling uses label + input pairs
  async function fillByLabel(labelPattern, value) {
    const filled = await page.evaluate(({ pattern, val }) => {
      const labels = Array.from(document.querySelectorAll('label'));
      const re = new RegExp(pattern, 'i');
      const lbl = labels.find(l => re.test(l.innerText || l.textContent || ''));
      if (!lbl) return false;
      const forId = lbl.htmlFor;
      const input = forId ? document.getElementById(forId) : lbl.nextElementSibling || lbl.querySelector('input, textarea');
      if (!input) return false;
      if (input.value) return true; // already filled
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeInputValueSetter.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { pattern: labelPattern, val: String(value) }).catch(() => false);
    return filled;
  }

  await fillByLabel('first.?name', a.firstName);
  await fillByLabel('last.?name', a.lastName);
  await fillByLabel('email', a.email);
  await fillByLabel('phone', a.phoneDigits);
  await fillByLabel('linkedin', a.linkedIn);
  await fillByLabel('city|location', a.city + ', ' + a.state);

  // Fallback selectors
  await fill('input[name*="firstName" i], input[id*="firstName" i], input[placeholder*="First" i]', a.firstName);
  await fill('input[name*="lastName" i], input[id*="lastName" i], input[placeholder*="Last" i]', a.lastName);
  await fill('input[type="email"], input[name*="email" i], input[id*="email" i]', a.email);
  await fill('input[type="tel"], input[name*="phone" i], input[id*="phone" i]', a.phoneDigits);

  // Resume upload
  trace.stage("rippling:resume");
  const up = await attachResume(page, page, a.resumePath);
  if (!up.ok) return up.result;

  // Custom questions
  for (const ta of await page.$$('textarea')) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    if (await ta.inputValue().catch(() => '')) continue;
    const label = await ta.evaluate(el => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const lbl = p.querySelector('label, [class*="label"]')?.innerText?.trim();
        if (lbl) return lbl.slice(0, 240);
        p = p.parentElement;
      }
      return '';
    }).catch(() => '');
    if (/^\\s*(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\\b/i.test(label)) {
      const yn = yesNoForLabel(label, a);
      if (yn) { await ta.fill(yn).catch(() => {}); continue; }
    }
    const ans = generateAnswer(label, a);
    if (ans) await ta.fill(ans).catch(() => {});
  }

  // Native selects
  for (const sel of await page.$$('select')) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const cur = await sel.evaluate(el => el.value).catch(() => '');
    if (cur) continue;
    const label = await sel.evaluate(el => (el.closest('div,fieldset,label')?.innerText || '').slice(0, 200)).catch(() => '');
    const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim())).catch(() => []);
    if (/sponsor/i.test(label)) {
      const no = opts.find(o => /^no\b/i.test(o));
      if (no) await sel.selectOption({ label: no }).catch(() => {});
    } else if (/authoriz.*work|eligible.*work/i.test(label)) {
      const yes = opts.find(o => /^yes\b/i.test(o));
      if (yes) await sel.selectOption({ label: yes }).catch(() => {});
    }
  }

  await handleRadioGroups(page).catch(() => {});
  await fillRemainingRequired(page).catch(() => {});

  trace.stage("rippling:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: a, jobMeta });
  if (reviewBlock) return reviewBlock;

  const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), button:has-text("Apply"), input[type="submit"]').catch(() => null);
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found' };

  if (process.env.DRY_RUN) {
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    const fname = dryRunShotPath((jobMeta && jobMeta.company) || 'rippling');
    await page.screenshot({ path: fname, fullPage: true }).catch(() => {});
    return { status: 'DryRun', reason: 'all required filled — screenshot ' + fname };
  }

  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await submitBtn.click({ timeout: 10000 }).catch(() => {});

  const CONFIRM = /thank you|application (received|submitted|complete)|your application|submitted successfully|we.ve received|thanks for applying|application sent/i;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(body)) return { status: 'Applied', reason: '—' };
    if (/\/confirmation|\/success|\/thank/.test(page.url())) return { status: 'Applied', reason: '—' };
  }
  return { status: 'Error', reason: 'No confirmation after submit' };
}

module.exports = { applyRippling };
