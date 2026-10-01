// BambooHR ATS handler.
// BambooHR career pages: *.bamboohr.com/careers/<id> or *.bamboohr.com/jobs/<id>
// No account creation needed — BambooHR uses a direct apply form with no login.
//
// Flow:
//   1. Navigate to job URL
//   2. Click "Apply for This Job" button (React button that expands the form on the same page)
//   3. Wait for form fields to appear (firstName, lastName, etc.)
//   4. Fill: name, email, phone, address
//   5. Upload resume via input[type=file]
//   6. Fill custom questions (radios, selects, textareas)
//   7. Submit and confirm
//
// FIX 2026-09-12: The new BambooHR React UI puts the form BEHIND an "Apply for This Job"
// button — clicking it expands the form inline on the same page. The old handler was
// trying to fill fields before clicking this button, which is why it saw no upload control.

const a = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { fillRemainingRequired, handleRadioGroups, dryRunShotPath } = require('../util/form');
const { attachResume } = require('../resume/upload');
const { gateBeforeSubmit } = require('../util/answer-review');
const { yesNoForLabel } = require('../util/answers-map');

const trace = require("../util/trace");
async function applyBamboohr(page, jobMeta) {
  trace.stage("bamboohr");
  console.log('    [bamboohr] starting application…');
  await page.waitForTimeout(2000);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');

  // Location/citizenship check
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bPune\b|\bHyderabad\b|\bChennai\b|\bArgentina\b|\bMexico\b|\bColombia\b|\bBrazil\b|\bLATAM\b/i.test(pageText)) {
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

  // ── Step 1: Click "Apply for This Job" button to expand the form ──────────
  // BambooHR's new React UI shows the form only AFTER clicking this button.
  // The button has onclick handler and expands the form inline.
  const applyFormVisible = await page.$('input#firstName, input[name="firstName"]').catch(() => null);

  if (!applyFormVisible) {
    console.log('    [bamboohr] looking for Apply button to expand form…');

    // Try various selectors for the expand button
    let clicked = false;
    for (const sel of [
      'button:has-text("Apply for This Job")',
      'button:has-text("Apply Now")',
      'button:has-text("Apply")',
      'a:has-text("Apply for This Job")',
      'a:has-text("Apply Now")',
    ]) {
      const btn = await page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        console.log('    [bamboohr] clicking:', sel);
        await btn.click().catch(() => {});
        await page.waitForTimeout(3000);
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      // Check if we're on a listing page — try navigating to /apply subpath
      const currentUrl = page.url();
      if (!currentUrl.includes('/apply')) {
        const applyUrl = currentUrl.replace(/\/?$/, '') + '/apply';
        console.log('    [bamboohr] trying direct /apply URL:', applyUrl);
        await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // Wait for form to appear
    await page.waitForSelector(
      'input#firstName, input[name="firstName"], input[name="first_name"], input[id*="firstName"]',
      { timeout: 12000 }
    ).catch(() => {});
    await page.waitForTimeout(800);
  }

  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && val) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.fill(String(val)).catch(() => {});
    }
  };

  // ── Step 2: Fill standard fields ─────────────────────────────────────────
  // BambooHR uses stable IDs: firstName, lastName, email, phone, etc.
  await fill('input#firstName, input[name="firstName"], input[name="first_name"], input[id*="firstName"]', a.firstName);
  await fill('input#lastName, input[name="lastName"], input[name="last_name"], input[id*="lastName"]', a.lastName);
  await fill('input#email, input[type="email"], input[name="email"], input[id*="email"]', a.email);
  await fill('input#phone, input[type="tel"], input[name="phone"], input[id*="phone"]', a.phoneDigits);

  // Address fields
  await fill('input[name="streetAddress.value"], input[name="address"], input[id*="address"]', a.addressLine1 || a.city + ', ' + a.state);
  await fill('input[name="city.value"], input[name="city"], input[id*="city"]', a.city);
  await fill('input[name="zip.value"], input[name="zip"], input[id*="zip"]', a.zip || '');

  // State select — BambooHR uses a custom fab-SelectToggle dropdown, not a native <select>.
  // Must click the toggle button, wait for the menu to open, then click the state option.
  try {
    const stateToggleBtn = await page.$('button.fab-SelectToggle[aria-label*="State"]').catch(() => null);
    // No state on the persona → leave the field alone rather than click the first option.
    if (stateToggleBtn && (a.stateFull || a.state)) {
      await stateToggleBtn.click().catch(() => {});
      await page.waitForTimeout(800);
      // Click the matching state in the fab-MenuOption list
      const stateVal = a.stateFull || a.state || '';
      // Try exact text match first
      let stateOption = await page.evaluate((st) => {
        const opts = [...document.querySelectorAll('.fab-MenuOption')];
        const hit = opts.find(o => o.innerText.trim() === st);
        if (hit) { hit.click(); return true; }
        const partial = opts.find(o => o.innerText.trim().toLowerCase().startsWith(st.toLowerCase()));
        if (partial) { partial.click(); return true; }
        return false;
      }, stateVal).catch(() => false);
      if (!stateOption) {
        // Fallback: click via DOM evaluation
        stateOption = await page.evaluate((st) => {
          const opts = [...document.querySelectorAll('.fab-MenuOption')];
          const hit = opts.find(o => o.innerText.includes(st));
          if (hit) { hit.click(); return true; }
          return false;
        }, stateVal).catch(() => false);
      }
      if (stateOption) {
        await page.waitForTimeout(400);
        console.log('    [bamboohr] state selected:', stateVal);
      } else {
        console.log('    [bamboohr] state option not found for:', stateVal);
      }
    }
  } catch(e) {
    console.log('    [bamboohr] state selection warning:', e.message.slice(0, 80));
  }

  // Desired pay (fill with reasonable value)
  await fill('input#desiredPay, input[name="desiredPay"]', a.salaryRangeString || '120000');

  // LinkedIn / website
  await fill('input#linkedinUrl, input[name="linkedinUrl"], input[name*="linkedin" i], input[id*="linkedin" i]', a.linkedIn);
  await fill('input#websiteUrl, input[name="websiteUrl"], input[name*="website" i], input[id*="website" i]', a.linkedIn);

  // ── Step 3: Resume upload ──────────────────────────────────────────────────
  // BambooHR uses input[type="file"] with class "fabric-bc1bde-input" (React-based).
  // After setInputFiles, the filename appears in the page but NOT in standard upload
  // widget selectors (it uses "fabric-1buwp1x-root" classes). We do a direct upload
  // then verify the filename appears anywhere in the page (which the debug confirmed works).
  const resumeBasename = require('path').basename(a.resumePath);
  let resumeUploaded = false;

  const fileInputEl = await page.$('input[type="file"]').catch(() => null);
  if (fileInputEl) {
    try {
      await fileInputEl.setInputFiles(a.resumePath);
      await page.waitForTimeout(1500);
      // BambooHR shows the filename in the DOM after upload
      const filenameInPage = await page.evaluate((fn) => document.body.innerText.includes(fn), resumeBasename).catch(() => false);
      if (filenameInPage) {
        console.log('    [bamboohr] resume uploaded ✓ (filename confirmed in page)');
        resumeUploaded = true;
      } else {
        // Try file chooser via button
        for (const btnSel of ['button:has-text("Choose File")', 'button:has-text("Browse")', 'button:has-text("Upload")', 'label[for]:has-text("Resume")']) {
          const btn = await page.$(btnSel).catch(() => null);
          if (!btn) continue;
          const [chooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 4000 }).catch(() => null),
            btn.click().catch(() => {}),
          ]);
          if (chooser) {
            await chooser.setFiles(a.resumePath);
            await page.waitForTimeout(1500);
            const fn2 = await page.evaluate((fn) => document.body.innerText.includes(fn), resumeBasename).catch(() => false);
            if (fn2) { resumeUploaded = true; break; }
          }
        }
      }
    } catch (e) {
      console.log('    [bamboohr] file upload error:', e.message.slice(0, 100));
    }
  }

  if (!resumeUploaded) {
    return { status: 'Error', reason: 'BambooHR resume upload failed — filename not confirmed in page' };
  }

  // ── Step 4: Custom questions ───────────────────────────────────────────────
  // Cover letter textarea (optional)
  const clLabel = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll('label, .form-label'));
    return labels.some(l => /cover letter/i.test(l.innerText));
  }).catch(() => false);
  if (clLabel) {
    const clArea = await page.$('textarea[name*="cover" i], textarea[id*="cover" i], textarea[placeholder*="cover" i]').catch(() => null);
    if (clArea && !(await clArea.inputValue().catch(() => ''))) {
      await clArea.fill(a.whyThisRoleBlurb || a.elevatorPitch || '').catch(() => {});
    }
  }

  // Text areas
  for (const ta of await page.$$('textarea')) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    if (await ta.inputValue().catch(() => '')) continue;
    // Skip hidden/system textareas
    const id = await ta.getAttribute('id').catch(() => '');
    if (id && /recaptcha|g-recaptcha/i.test(id)) continue;
    const label = await ta.evaluate(el => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const lbl = p.querySelector('label, .form-label, .question-label')?.innerText?.trim();
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
    } else if (/authoriz.*work|eligible.*work|legally.*work/i.test(label)) {
      const yes = opts.find(o => /^yes\b/i.test(o));
      if (yes) await sel.selectOption({ label: yes }).catch(() => {});
    } else if (/how did you|hear about|find out/i.test(label)) {
      const li = opts.find(o => /linkedin/i.test(o)) || opts.find(o => /other/i.test(o));
      if (li) await sel.selectOption({ label: li }).catch(() => {});
    }
  }

  // Radio buttons and checkboxes
  await handleRadioGroups(page).catch(() => {});
  await fillRemainingRequired(page).catch(() => {});

  // BambooHR fallback: for any STILL-unchecked radio group, force-check the appropriate option.
  // BambooHR uses MUI radio buttons with PrivateSwitchBase-input inputs — check({force:true})
  // is required because the input is visually hidden behind the MUI component.
  {
    const allRadios = await page.$$('input[type="radio"]').catch(() => []);
    const groups = {};
    for (const r of allRadios) {
      const name = await r.getAttribute('name').catch(() => '');
      if (!name) continue;
      if (!groups[name]) groups[name] = [];
      groups[name].push(r);
    }
    for (const [name, group] of Object.entries(groups)) {
      const anyChecked = (await Promise.all(group.map(r => r.isChecked().catch(() => false)))).some(Boolean);
      if (anyChecked) continue;
      // Find the best option: 'Yes' for yes_no groups, last option for multi groups
      const yesOpt = group.find ? null : null; // placeholder
      let picked = null;
      for (const r of group) {
        const val = await r.getAttribute('value').catch(() => '');
        if (/^yes$/i.test(val)) { picked = r; break; }
      }
      if (!picked) picked = group[group.length - 1]; // last option (often "None of the above")
      if (picked) {
        await picked.check({ force: true }).catch(() => {});
        await page.waitForTimeout(100);
      }
    }
  }
  await page.waitForTimeout(300);

  // Pre-submit review
  trace.stage("bamboohr:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: a, jobMeta });
  if (reviewBlock) return reviewBlock;

  // ── Step 5: Check for reCAPTCHA before submit ────────────────────────────
  // BambooHR uses reCAPTCHA v2. If the g-recaptcha-response is empty, the captcha
  // hasn't been completed and the form will not submit. Detect and skip.
  const captchaResponse = await page.evaluate(() => {
    const rc = document.querySelector('#g-recaptcha-response, .g-recaptcha-response');
    return rc ? rc.value : null;
  }).catch(() => null);
  
  if (captchaResponse !== null && captchaResponse === '') {
    // reCAPTCHA is present but not completed — wait up to 30s for it to auto-complete
    console.log('    [bamboohr] reCAPTCHA detected — waiting up to 30s for completion…');
    let captchaSolved = false;
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(2000);
      const val = await page.evaluate(() => {
        const rc = document.querySelector('#g-recaptcha-response, .g-recaptcha-response');
        return rc ? rc.value : '';
      }).catch(() => '');
      if (val && val.length > 10) {
        console.log('    [bamboohr] reCAPTCHA completed automatically');
        captchaSolved = true;
        break;
      }
    }
    if (!captchaSolved) {
      return { status: 'Skipped', reason: 'BambooHR reCAPTCHA not solved — requires manual completion' };
    }
  }

  // ── Step 5: Submit ─────────────────────────────────────────────────────────
  const submitBtn = await page.$('button[type="submit"], button:has-text("Submit"), input[type="submit"]').catch(() => null);
  if (!submitBtn) return { status: 'Error', reason: 'BambooHR submit button not found' };

  if (process.env.DRY_RUN) {
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    const fname = dryRunShotPath((jobMeta && jobMeta.company) || 'bamboohr');
    await page.screenshot({ path: fname, fullPage: true }).catch(() => {});
    return { status: 'DryRun', reason: 'all required filled — screenshot ' + fname };
  }

  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await submitBtn.click({ timeout: 10000 }).catch(() => {});

  // Wait for confirmation
  const CONFIRM = /thank you|application (received|submitted|complete|sent)|your application|submitted successfully|we.ve received|thanks for applying|application was submitted|successfully applied|received your application/i;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(body)) return { status: 'Applied', reason: '—' };
    if (/\/confirmation|\/success|\/thank-you|\/applied|\/complete/.test(page.url())) return { status: 'Applied', reason: '—' };
  }
  return { status: 'Error', reason: 'No confirmation after submit' };
}

module.exports = { applyBamboohr };
