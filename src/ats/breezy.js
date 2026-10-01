// Breezy HR ATS handler.
// Breezy HR career pages: *.breezy.hr/p/<hash>-<job-title>
// Simple apply form: name, email, resume, cover letter, custom questions.
// No account creation — direct submit.
//
// Flow:
//   1. Navigate to job URL
//   2. Click "Apply" if a modal/form isn't already showing
//   3. Fill: name, email, phone, social links
//   4. Upload resume
//   5. Fill cover letter and custom questions
//   6. Submit and confirm

const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { fillRemainingRequired, handleRadioGroups, dryRunShotPath } = require('../util/form');
const { attachResume } = require('../resume/upload');
const { gateBeforeSubmit } = require('../util/answer-review');
const { yesNoForLabel } = require('../util/answers-map');

const trace = require("../util/trace");
async function applyBreezy(page, jobMeta) {
  trace.stage("breezy");
  console.log('    [breezy] starting application…');
  await page.waitForTimeout(2000);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');

  // Location check
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bLATAM\b/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Non-US location detected' };
  }
  if (/security clearance|US citizenship required|must be a US citizen|ITAR|export control/i.test(pageText)) {
    return { status: 'Skipped', reason: 'Requires US citizenship / clearance' };
  }

  // Click Apply button — Breezy uses a "Apply" button that opens a modal or scrolls to form
  const applyBtn = await page.$('a:has-text("Apply"), button:has-text("Apply"), a:has-text("Apply Now"), button:has-text("Apply Now"), a[href*="apply"], [data-label="Apply"]').catch(() => null);
  if (applyBtn) {
    await applyBtn.click().catch(() => {});
    await page.waitForTimeout(2500);
  }

  // Wait for form
  await page.waitForSelector('input[name="name"], input[name="first_name"], input[id*="name"], input[placeholder*="Name"]', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);

  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && val) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const cur = await el.inputValue().catch(() => '');
      if (!cur) await el.fill(String(val)).catch(() => {});
    }
  };

  // Breezy often uses "name" (full name) or separate first/last
  const nameField = await page.$('input[name="name"], input[placeholder*="Full Name" i], input[id="name"]').catch(() => null);
  if (nameField) {
    const cur = await nameField.inputValue().catch(() => '');
    if (!cur) await nameField.fill(a.fullName).catch(() => {});
  } else {
    await fill('input[name="first_name"], input[id*="firstName"], input[placeholder*="First Name" i]', a.firstName);
    await fill('input[name="last_name"], input[id*="lastName"], input[placeholder*="Last Name" i]', a.lastName);
  }

  await fill('input[type="email"], input[name="email"], input[id*="email"]', a.email);
  await fill('input[type="tel"], input[name="phone"], input[id*="phone"]', a.phoneDigits);

  // Social / profile links
  await fill('input[name*="linkedin" i], input[id*="linkedin" i], input[placeholder*="LinkedIn" i]', a.linkedIn);
  await fill('input[name*="website" i], input[id*="website" i], input[placeholder*="Website" i]', a.linkedIn);
  await fill('input[name*="github" i], input[id*="github" i], input[placeholder*="GitHub" i]', a.github || a.linkedIn);

  // Resume upload
  trace.stage("breezy:resume");
  const up = await attachResume(page, page, a.resumePath);
  if (!up.ok) return up.result;

  // Cover letter — Breezy often has a textarea for it
  const coverArea = await page.$('textarea[name*="cover" i], textarea[id*="cover" i], textarea[placeholder*="Cover Letter" i], textarea[placeholder*="cover letter" i]').catch(() => null);
  if (coverArea) {
    const cur = await coverArea.inputValue().catch(() => '');
    if (!cur) await coverArea.fill(a.whyThisRoleBlurb || a.elevatorPitch || '').catch(() => {});
  }

  // Custom questions — textareas
  for (const ta of await page.$$('textarea')) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    if (await ta.inputValue().catch(() => '')) continue;
    const label = await ta.evaluate(el => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const lbl = p.querySelector('label, .form-label, .question-label, h4, h5')?.innerText?.trim();
        if (lbl) return lbl.slice(0, 240);
        p = p.parentElement;
      }
      return '';
    }).catch(() => '');
    if (/cover letter/i.test(label)) continue;
    if (/^\s*(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\b/i.test(label)) {
      const yn = yesNoForLabel(label, a);
      if (yn) { await ta.fill(yn).catch(() => {}); continue; }
    }
    const ans = generateAnswer(label, a);
    if (ans) await ta.fill(ans).catch(() => {});
  }

  // Additional text inputs for custom questions
  for (const inp of await page.$$('input[type="text"]')) {
    if (await inp.evaluate(el => el.getAttribute('role') === 'combobox').catch(() => false)) continue;
    if (await inp.inputValue().catch(() => '')) continue;
    const label = await inp.evaluate(el => {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p; i++) {
        const lbl = p.querySelector('label, .form-label')?.innerText?.trim();
        if (lbl) return lbl.slice(0, 200);
        p = p.parentElement;
      }
      return '';
    }).catch(() => '');
    if (/name|email|phone|linkedin|github|website/i.test(label)) continue;
    if (/salary|compensation|expected pay/i.test(label)) { await inp.fill(a.salaryRangeString).catch(() => {}); continue; }
    if (/years.*experience|how many years/i.test(label)) { await inp.fill(String(a.totalYearsExperience)).catch(() => {}); continue; }
    if (/^\s*(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\b/i.test(label)) {
      const yn = yesNoForLabel(label, a);
      if (yn) { await inp.fill(yn).catch(() => {}); continue; }
    }
    const ans = generateAnswer(label, a);
    if (ans) await inp.fill(ans.slice(0, 300)).catch(() => {});
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
    } else if (/how did you|hear about/i.test(label)) {
      const li = opts.find(o => /linkedin/i.test(o)) || opts.find(o => /other/i.test(o));
      if (li) await sel.selectOption({ label: li }).catch(() => {});
    }
  }

  await handleRadioGroups(page).catch(() => {});
  await fillRemainingRequired(page).catch(() => {});

  trace.stage("breezy:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: a, jobMeta });
  if (reviewBlock) return reviewBlock;

  const submitBtn = await page.$('button[type="submit"], button:has-text("Submit Application"), button:has-text("Submit"), input[type="submit"]').catch(() => null);
  if (!submitBtn) return { status: 'Error', reason: 'Submit button not found' };

  if (process.env.DRY_RUN) {
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    const fname = dryRunShotPath((jobMeta && jobMeta.company) || 'breezy');
    await page.screenshot({ path: fname, fullPage: true }).catch(() => {});
    return { status: 'DryRun', reason: 'all required filled — screenshot ' + fname };
  }

  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await submitBtn.click({ timeout: 10000 }).catch(() => {});

  const CONFIRM = /thank you|application (received|submitted|complete)|your application|submitted successfully|we.ve received|thanks for applying/i;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(body)) return { status: 'Applied', reason: '—' };
    if (/\/confirmation|\/success|\/thank/.test(page.url())) return { status: 'Applied', reason: '—' };
  }
  return { status: 'Error', reason: 'No confirmation after submit' };
}

module.exports = { applyBreezy };
