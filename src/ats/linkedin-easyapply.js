// LinkedIn Easy Apply handler — submits the multi-step Easy Apply modal as the
// active persona (cloud/fullstack/qa). Logged-in LinkedIn pre-fills contact info;
// we fill screening questions from the persona answers, upload the persona resume,
// and walk Next → Review → Submit.
//
// Guardrails (so we never submit a broken application):
//   - Max 7 modal steps, then bail (dismiss without submitting).
//   - If a REQUIRED field is left empty after our best effort, bail (no submit).
//   - Only returns Applied on the explicit "application sent" confirmation.
//
// Returns: { status: 'Applied'|'Skipped'|'Error', reason }

const a = require('../answers');

const sleep = (p, ms) => p.waitForTimeout(ms);

// Best-effort answer for a screening question based on its label text.
function answerFor(label) {
  const l = label.toLowerCase();
  // Numeric "how many years..." → experience number
  if (/how many years|years of experience|years of work|years do you have/.test(l)) {
    if (/aws|azure|gcp|cloud|devops|kubernetes|terraform|linux|python/.test(l)) return '5';
    return String(a.totalYearsExperience || 5);
  }
  if (/notice period/.test(l)) return '2 weeks';
  if (/salary|compensation|desired pay|expected/.test(l)) return String(a.salaryTarget || 110000);
  if (/city|located|location|where are you/.test(l)) return `${a.city}, ${a.state}`;
  if (/phone/.test(l)) return a.phoneDigits;
  if (/linkedin/.test(l)) return a.linkedIn;
  if (/first name/.test(l)) return a.firstName;
  if (/last name/.test(l)) return a.lastName;
  if (/email/.test(l)) return a.email;
  // Generic numeric field → conservative
  return null;
}

// Yes/No decision for dropdowns & radios from label text.
function yesNoFor(label) {
  const l = label.toLowerCase();
  if (/sponsor|visa|h-?1b|require sponsorship/.test(l)) return 'No';
  if (/authoriz|legally|eligible to work|work authorization|right to work/.test(l)) return 'Yes';
  if (/18 years|over 18|at least 18/.test(l)) return 'Yes';
  if (/background check|drug (screen|test)|consent/.test(l)) return 'Yes';
  if (/relocat/.test(l)) return 'No';
  if (/remote/.test(l)) return 'Yes';
  if (/felony|convicted|criminal/.test(l)) return 'No';
  if (/veteran/.test(l)) return 'No';
  if (/disab/.test(l)) return 'No';
  if (/comfortable|able to|willing to|do you have/.test(l)) return 'Yes';
  return 'Yes'; // default optimistic for "do you have experience with X"
}

async function getLabelFor(modal, el) {
  return await el.evaluate(node => {
    // Prefer an associated <label>, then aria-label, then nearest preceding text.
    const id = node.id;
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab && lab.innerText.trim()) return lab.innerText.trim();
    }
    if (node.getAttribute('aria-label')) return node.getAttribute('aria-label').trim();
    let p = node.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      const lab = p.querySelector('label');
      if (lab && lab.innerText.trim()) return lab.innerText.trim();
      p = p.parentElement;
    }
    return '';
  }).catch(() => '');
}

async function fillStep(modal, page) {
  // Resume upload if an empty file input is present.
  const fileInput = await modal.$('input[type="file"]');
  if (fileInput) {
    const hasResume = await modal.$('.jobs-document-upload-redesign-card__container, [class*="resume"]');
    if (!hasResume) await fileInput.setInputFiles(a.resumePath).catch(() => {});
  }

  // Text inputs / textareas
  for (const el of await modal.$$('input[type="text"], input[type="tel"], input[type="number"], input:not([type]), textarea')) {
    const visible = await el.isVisible().catch(() => false);
    if (!visible) continue;
    const cur = await el.inputValue().catch(() => '');
    if (cur && cur.trim()) continue; // already filled (LinkedIn prefilled)
    const label = await getLabelFor(modal, el);
    const ans = answerFor(label);
    if (ans != null) await el.fill(ans).catch(() => {});
  }

  // Native selects
  for (const sel of await modal.$$('select')) {
    const visible = await sel.isVisible().catch(() => false);
    if (!visible) continue;
    const label = await getLabelFor(modal, sel);
    const want = yesNoFor(label);
    // Try to choose the option whose text matches our yes/no; else first non-placeholder.
    const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim()));
    let pick = opts.find(o => new RegExp(`^${want}$`, 'i').test(o)) ||
               opts.find(o => o && !/^select|^choose|^\s*$/i.test(o));
    if (pick) await sel.selectOption({ label: pick }).catch(() => {});
  }

  // Radio groups (fieldset) — choose by label
  for (const fs of await modal.$$('fieldset')) {
    const legend = await fs.evaluate(n => n.querySelector('legend')?.innerText?.trim() || '').catch(() => '');
    const want = yesNoFor(legend);
    const radios = await fs.$$('input[type="radio"]');
    for (const r of radios) {
      const rl = await getLabelFor(fs, r);
      if (new RegExp(`^${want}$`, 'i').test(rl.trim())) { await r.check().catch(() => {}); break; }
    }
  }
}

// Detect required fields still empty/invalid (LinkedIn shows inline error text).
async function hasUnfilledRequired(modal) {
  return await modal.evaluate(() => {
    return !!document.querySelector('.artdeco-inline-feedback--error, [class*="error"] .artdeco-inline-feedback__message');
  }).catch(() => false);
}

async function applyLinkedInEasyApply(ctx, page, job) {
  // Click the Easy Apply button to open the modal.
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('.jobs-apply-button') ||
      Array.from(document.querySelectorAll('button')).find(b => /easy apply/i.test(b.innerText));
    if (!btn) return false;
    btn.click(); return true;
  }).catch(() => false);
  if (!clicked) return { status: 'Error', reason: 'Easy Apply button not found' };

  await sleep(page, 2200);
  let modal = await page.$('.jobs-easy-apply-modal, [role="dialog"]');
  if (!modal) return { status: 'Error', reason: 'Easy Apply modal did not open' };

  for (let step = 0; step < 7; step++) {
    modal = await page.$('.jobs-easy-apply-modal, [role="dialog"]');
    if (!modal) break;
    await fillStep(modal, page);
    await sleep(page, 400);

    // Find footer action button: Submit > Review > Next/Continue
    const btn = await page.evaluateHandle(() => {
      const inModal = (b) => b.closest('[role="dialog"], .jobs-easy-apply-modal');
      const all = Array.from(document.querySelectorAll('button')).filter(inModal);
      const byLabel = (re) => all.find(b => re.test((b.getAttribute('aria-label') || b.innerText || '')));
      return byLabel(/submit application/i) || byLabel(/^submit$/i) ||
             byLabel(/review/i) || byLabel(/continue to next|next|continue/i) || null;
    });
    const el = btn.asElement();
    if (!el) break;
    const labelTxt = await el.evaluate(n => (n.getAttribute('aria-label') || n.innerText || '').toLowerCase()).catch(() => '');

    const isSubmit = /submit/.test(labelTxt);
    if (isSubmit) {
      if (await hasUnfilledRequired(modal)) {
        await page.keyboard.press('Escape').catch(() => {});
        return { status: 'Error', reason: 'Required Easy Apply question unanswered — bailed without submitting' };
      }
      // Uncheck "follow company" if present
      await page.evaluate(() => {
        const f = document.querySelector('#follow-company-checkbox, input[id*="follow"]');
        if (f && f.checked) f.click();
      }).catch(() => {});
      await el.click().catch(() => {});
      await sleep(page, 3000);
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (/application was sent|your application was sent|application sent|applied/i.test(body)) {
        // Dismiss the post-apply modal
        await page.keyboard.press('Escape').catch(() => {});
        return { status: 'Applied', reason: '— (Easy Apply)' };
      }
      return { status: 'Error', reason: 'Submitted but no confirmation detected' };
    }

    // If required fields are still flagged, we can't advance — bail.
    if (await hasUnfilledRequired(modal)) {
      await page.keyboard.press('Escape').catch(() => {});
      return { status: 'Error', reason: 'Easy Apply step has unfillable required field — bailed' };
    }
    await el.click().catch(() => {});
    await sleep(page, 1400);
  }

  await page.keyboard.press('Escape').catch(() => {});
  return { status: 'Error', reason: 'Easy Apply exceeded step limit — bailed without submitting' };
}

module.exports = { applyLinkedInEasyApply };
