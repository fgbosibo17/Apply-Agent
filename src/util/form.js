// Shared form-filling helpers used across ATS handlers.
const a = require('../answers');
const { textValueForLabel, optionForLabel } = require('./answers-map');
const { generateAnswer } = require('../answer-bank');
const { getEmailCode } = require('./email-code');
const { getLearned, saveLearned } = require('./learned');

// Best-effort label text for a field element (walks up to a label/legend/heading).
async function labelOf(el) {
  return el.evaluate((e) => {
    if (e.id) { const l = document.querySelector(`label[for="${CSS.escape(e.id)}"]`); if (l && l.innerText.trim()) return l.innerText.trim(); }
    let p = e.parentElement;
    for (let i = 0; i < 6 && p; i++) {
      const l = p.querySelector('label, legend, h3, .application-label, [class*="label"]');
      if (l && l.innerText && l.innerText.trim()) return l.innerText.trim();
      p = p.parentElement;
    }
    return e.getAttribute('aria-label') || e.placeholder || '';
  }).catch(() => '');
}

// Fill all still-empty visible text inputs / textareas by their label.
// `skip` is a regex of field name/id to ignore (already handled explicitly).
async function fillTextByLabel(scope, opts = {}) {
  const skip = opts.skip || /^$/;
  const els = await scope.$$('input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea').catch(() => []);
  for (const el of els) {
    const nm = await el.evaluate((e) => (e.name || '') + ' ' + (e.id || '')).catch(() => '');
    if (skip.test(nm)) continue;
    const role = await el.evaluate((e) => e.getAttribute('role') || '').catch(() => '');
    if (role === 'combobox') continue; // react-select input — handled by select logic
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;
    const label = await labelOf(el);
    const val = textValueForLabel(label, a) || getLearned(label);
    if (val) await el.fill(String(val).slice(0, 2000)).catch(() => {});
  }
}

// Handle radio-button groups (group by `name`): pick the option whose label best
// matches our answer for the group's question.
async function handleRadioGroups(scope) {
  const radios = await scope.$$('input[type="radio"]').catch(() => []);
  const groups = {};
  for (const r of radios) {
    const name = await r.getAttribute('name').catch(() => '') || '';
    (groups[name] = groups[name] || []).push(r);
  }
  for (const name of Object.keys(groups)) {
    const group = groups[name];
    // already chosen?
    let chosen = false;
    for (const r of group) if (await r.isChecked().catch(() => false)) chosen = true;
    if (chosen) continue;
    // question label = label of the fieldset / first radio's container
    const qLabel = await groupQuestionLabel(group[0]);
    // option labels
    const opts = [];
    for (const r of group) opts.push({ r, text: await radioLabel(r) });
    let pick = optionForLabel(qLabel, opts.map((o) => o.text), a);
    // Unknown custom screening question: if it's a binary Yes/No group, default
    // to Yes — EXCEPT honesty questions (gov official / PEP / conflict / felony)
    // and EEO/self-ID questions (disability/veteran/gender/race), which must
    // never be affirmed by default.
    const optBlob = opts.map((o) => o.text).join(' || ').toLowerCase();
    const sensitive = /government|public official|politically|\bpep\b|conflict of interest|felony|convicted|criminal|public office|elected|sponsor/i.test(qLabel)
      || /have a disability|protected veteran|hispanic or latino|black or african american|gender identity|sexual orientation/i.test(optBlob);
    if (!pick && !sensitive) {
      const yesOpt = opts.find((o) => /^\s*yes\b/i.test(o.text));
      const isBinary = opts.length <= 3 && yesOpt && opts.some((o) => /^\s*no\b/i.test(o.text));
      if (isBinary) pick = yesOpt.text;
    }
    if (!pick) continue;
    const hit = opts.find((o) => o.text.trim().toLowerCase() === pick.trim().toLowerCase()) ||
                opts.find((o) => o.text.trim().toLowerCase().includes(pick.trim().toLowerCase()));
    if (hit) {
      await hit.r.scrollIntoViewIfNeeded().catch(() => {});
      await hit.r.check({ timeout: 4000 }).catch(async () => {
        // some ATSs hide the input; click its label instead
        await hit.r.evaluate((e) => { const l = e.closest('label') || document.querySelector(`label[for="${e.id}"]`); (l || e).click(); }).catch(() => {});
      });
    }
  }
}

async function radioLabel(r) {
  return r.evaluate((e) => {
    const l = (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label');
    return (l && l.innerText.trim()) || e.value || '';
  }).catch(() => '');
}

async function groupQuestionLabel(r) {
  return r.evaluate((e) => {
    let p = e.parentElement;
    for (let i = 0; i < 8 && p; i++) {
      const lg = p.querySelector('legend, .application-label, h3, [class*="question"], label');
      if (lg && lg.innerText && lg.innerText.trim() && !/^(yes|no)\b/i.test(lg.innerText.trim())) return lg.innerText.trim().slice(0, 200);
      p = p.parentElement;
    }
    return '';
  }).catch(() => '');
}

// Handle native <select> elements by label.
async function handleNativeSelects(scope) {
  for (const sel of await scope.$$('select').catch(() => [])) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const cur = await sel.evaluate((e) => e.value).catch(() => '');
    if (cur && !/^(|0)$/.test(cur) && !/select|choose|please/i.test(cur)) continue;
    const label = await labelOf(sel);
    const opts = await sel.$$eval('option', (os) => os.map((o) => o.textContent.trim())).catch(() => []);
    const pick = optionForLabel(label, opts, a);
    if (pick) await sel.selectOption({ label: opts.find((o) => o.toLowerCase().includes(pick.toLowerCase())) || pick }).catch(() => {});
  }
}

// Safety net: fill ANY still-empty required field so a missed custom question
// never silently blocks submit. Label-mapped value first, else a sensible default.
async function fillRemainingRequired(scope) {
  // Required checkboxes are consent/acknowledgement ("I agree", "I certify") →
  // safe to check. (Single required checkbox on a job form is always consent.)
  for (const cb of await scope.$$('input[type="checkbox"]').catch(() => [])) {
    if (!(await cb.isVisible().catch(() => false))) continue;
    if (await cb.isChecked().catch(() => false)) continue;
    const required = await cb.evaluate((e) => e.required || e.getAttribute('aria-required') === 'true').catch(() => false);
    const label = await labelOf(cb);
    if (required || /consent|agree|privacy|terms|process my|gdpr|acknowledge|certify|i confirm/i.test(label)) {
      await cb.check({ timeout: 3000 }).catch(async () => {
        await cb.evaluate((e) => { const l = e.closest('label') || document.querySelector(`label[for="${e.id}"]`); (l || e).click(); }).catch(() => {});
      });
    }
  }
  for (const el of await scope.$$('input[required], textarea[required], input[aria-required="true"], textarea[aria-required="true"]').catch(() => [])) {
    const type = await el.evaluate((e) => e.type).catch(() => '');
    if (/file|checkbox|radio|hidden|submit|button/.test(type)) continue;
    // NEVER text-fill a react-select's internal input (type=text, role=combobox,
    // aria-required) — it has no inputValue when a value is chosen, so it looks
    // "empty", and typing into it CLEARS the already-selected option.
    const role = await el.evaluate((e) => e.getAttribute('role') || '').catch(() => '');
    if (role === 'combobox') continue;
    if (!(await el.isVisible().catch(() => false))) continue;
    if (await el.inputValue().catch(() => '')) continue;
    const label = await labelOf(el);
    let val = textValueForLabel(label, a);          // 1. built-in mapping
    if (!val) val = getLearned(label);              // 2. answered before? reuse
    if (!val) {                                     // 3. NEW question → think + save
      const tag = await el.evaluate((e) => e.tagName).catch(() => 'INPUT');
      // Open-ended / question-like → a real written answer; otherwise a NEUTRAL
      // "N/A" (NEVER a location or random token in an unrelated field).
      if (tag === 'TEXTAREA' || /\?|why|describe|tell us|explain|how (would|do|did)|what (makes|interests|excites)|cover letter|anything else|additional|experience|background|relevant|in your own words|elaborate|provide (details|examples)|walk us through/i.test(label)) {
        val = generateAnswer(label || 'your background', a);
      } else {
        val = 'N/A';
      }
      saveLearned(label, val);                      // remember for next time
    }
    if (val) await el.fill(String(val).slice(0, 2000)).catch(() => {});
  }
  // Required native selects still unset → pick the first real option.
  for (const sel of await scope.$$('select[required], select[aria-required="true"]').catch(() => [])) {
    if (!(await sel.isVisible().catch(() => false))) continue;
    const cur = await sel.evaluate((e) => e.value).catch(() => '');
    if (cur && !/^(|0)$/.test(cur)) continue;
    await sel.evaluate((e) => {
      const o = [...e.options].find((o) => o.value && !/^(|0)$/.test(o.value) && !/select|choose|please/i.test(o.textContent));
      if (o) { e.value = o.value; e.dispatchEvent(new Event('change', { bubbles: true })); }
    }).catch(() => {});
  }
}

// PROOF-READ pass — run right before submit. Catches obviously-wrong answers the
// fill heuristics produced and corrects them, so we never submit nonsense:
//   - a location value (Houston/Texas/US) sitting in a NON-location field
//     (e.g. "Who referred you?" → "Houston")  → re-answer or "N/A"
//   - a state/city value in a referral/recruiter/"how heard" field
//   - a bare "Yes"/"No" typed into a long free-text field
// Only touches visible text inputs/textareas that already have a value.
async function proofread(scope) {
  const LOC = /\b(houston|texas|\bTX\b|united states|dallas|austin|san antonio)\b/i;
  for (const el of await scope.$$('input[type="text"], input[type="email"], input:not([type]), textarea').catch(() => [])) {
    const role = await el.evaluate((e) => e.getAttribute('role') || '').catch(() => '');
    if (role === 'combobox') continue; // never rewrite a react-select's input
    if (!(await el.isVisible().catch(() => false))) continue;
    const val = (await el.inputValue().catch(() => '')) || '';
    if (!val.trim()) continue;
    const label = await labelOf(el);
    const ll = label.toLowerCase();
    const isLocationField = /location|^city|town|\bstate\b|province|address|zip|postal|country|where.*(based|located|reside|live)|relocat/.test(ll);
    const isReferral = /referr|recruit|who (told|referred)|how did you hear|source|employee.*refer/.test(ll);
    let fix = null;
    // location value in a non-location field → wrong
    if (LOC.test(val) && !isLocationField && val.length < 40) {
      if (isReferral) fix = /how did you hear/.test(ll) ? a.howDidYouHear : 'N/A';
      else { const m = textValueForLabel(label, a); fix = (m && !LOC.test(m)) ? m : 'N/A'; }
    }
    // referral/recruiter field that got a non-empty junk value → N/A (unless it's a real name we set, which we never do)
    else if (isReferral && /referr|recruit|who (told|referred)/.test(ll) && !/how did you hear/.test(ll) && val.length < 40 && !/n\/a|none|n\.a\./i.test(val)) {
      // leave real answers alone; only fix location/state junk (handled above). otherwise keep.
    }
    if (fix && fix !== val) await el.fill(String(fix)).catch(() => {});
  }
}

// DRY_RUN guard: screenshot and return a DryRun result (no submit). Returns null
// when DRY_RUN is off so the caller proceeds to submit.
async function dryRunStop(page, company, note) {
  if (!process.env.DRY_RUN) return null;
  const fname = `dryrun-${company || 'ats'}.png`;
  await page.screenshot({ path: fname, fullPage: true }).catch(() => {});
  return { status: 'DryRun', reason: (note || 'filled') + ' — ' + fname };
}

// Poll for a confirmation signal after submit (handles inline + redirect).
async function confirmAfterSubmit(page, scope, { re, urlRe, rounds = 7, waitMs = 2000 } = {}) {
  const CONFIRM = re || /thank you for applying|application (was )?(received|successfully submitted|submitted)|your application has been (submitted|received)|we(?:'| ha)ve received your application|thanks for applying|application complete/i;
  const URLC = urlRe || /\/confirmation|\/thanks|\/success|application_confirmation|\/complete/i;
  for (let i = 0; i < rounds; i++) {
    await page.waitForTimeout(waitMs);
    if (URLC.test(page.url())) return true;
    const pageBody = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '');
    let frameBody = '';
    try { if (scope && scope !== page) frameBody = await scope.evaluate(() => document.body.innerText.slice(0, 2000)); } catch {}
    if (CONFIRM.test(pageBody + ' ' + frameBody)) return true;
  }
  return false;
}

// After clicking submit, some ATSs (Workable, iCIMS) require an emailed code.
// Detect a code-entry field, fetch the code from Gmail, type it, continue.
async function handleEmailVerification(context, page, scope = page) {
  // Be specific: match true one-time-code fields, NOT "postcode"/"country code"/"area code".
  const codeInput = await (scope.$('input[autocomplete="one-time-code"], input[name="verification_code"], input[name*="verificationCode" i], input[id*="verification" i], input[name*="otp" i], input[placeholder*="verification code" i], input[aria-label*="verification code" i], input[placeholder*="confirmation code" i]').catch(() => null));
  if (!codeInput) return { needed: false };
  if (!(await codeInput.isVisible().catch(() => false))) return { needed: false };
  console.log('   email verification code required — checking Gmail...');
  const code = await getEmailCode(context, { timeoutMs: 120000 });
  if (!code) return { needed: true, ok: false };
  await codeInput.fill(code).catch(() => {});
  // submit the code
  const btn = await scope.$('button:has-text("Verify"), button:has-text("Confirm"), button:has-text("Submit"), button[type="submit"]').catch(() => null);
  if (btn) await btn.click().catch(() => {});
  await page.waitForTimeout(2500);
  return { needed: true, ok: true, code };
}

module.exports = {
  labelOf, fillTextByLabel, handleRadioGroups, handleNativeSelects,
  fillRemainingRequired, proofread, dryRunStop, confirmAfterSubmit, handleEmailVerification,
};
