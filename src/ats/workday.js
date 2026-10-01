// Workday ATS handler.
// Workday requires an account per company (each myworkdayjobs.com subdomain is a
// separate tenant). This handler creates the account on first visit (using the
// persona credentials from data/ats-accounts.json), handles Gmail verification,
// then fills the multi-step application.
//
// Flow:
//   1. Navigate to the job URL
//   2. Detect if sign-in or create-account is needed
//   3. Create account (or sign in) using persona credentials
//   4. Handle email verification via Gmail (open new tab → search → click link)
//   5. Fill multi-step form: My Information → Work Experience → Education →
//      Application Questions → Self Identify → Voluntary Disclosures → Review
//   6. Submit and confirm

const path = require('path');
const fs   = require('fs');
const a    = require('../answers');
const { generateAnswer }       = require('../answer-bank');
const { fillRemainingRequired, handleRadioGroups } = require('../util/form');
const { attachResume }         = require('../resume/upload');
const trace = require("../util/trace");
const { gateBeforeSubmit }     = require('../util/answer-review');
const { yesNoForLabel }        = require('../util/answers-map');
const { pickEeo, eeoValue }    = require('../util/eeo');

// ── Credential helpers ──────────────────────────────────────────────────────

const ACCOUNTS_FILE = path.resolve(__dirname, '../../data/ats-accounts.json');

function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return { personas: {}, accounts_created: {} }; }
}

function saveAccounts(data) {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8'); }
  catch (e) { console.error('    ⚠ Could not save ats-accounts.json:', e.message); }
}

function getCredentials(persona) {
  const data = loadAccounts();
  // A parallel session (primary2) signs in with its base persona's account.
  const cred = (data.personas || {})[persona] || (data.personas || {})[String(persona).replace(/\d+$/, '')];
  if (!cred) throw new Error(`No ATS credentials for persona "${persona}" in data/ats-accounts.json`);
  return cred;
}

function isAccountCreated(persona, tenantKey) {
  const data = loadAccounts();
  return !!((data.accounts_created || {})[`workday:${persona}:${tenantKey}`]);
}

function markAccountCreated(persona, tenantKey) {
  const data = loadAccounts();
  if (!data.accounts_created) data.accounts_created = {};
  data.accounts_created[`workday:${persona}:${tenantKey}`] = {
    created: true,
    createdAt: new Date().toISOString(),
  };
  saveAccounts(data);
}

// Extract a stable tenant key from a Workday URL.
// e.g. https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers/job/...
//      → 'acme'
function tenantKey(url) {
  const m = url.match(/^https?:\/\/([^.]+)\./i);
  return m ? m[1].toLowerCase() : 'unknown';
}

// ── Gmail verification ──────────────────────────────────────────────────────

async function handleGmailVerification(context) {
  console.log('    [workday] opening Gmail to find verification email…');
  const gmailPage = await context.newPage();
  try {
    await gmailPage.goto('https://mail.google.com/mail/u/0/#search/from%3Aworkday+newer_than%3A5m+verify', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await gmailPage.waitForTimeout(3000);

    // Click the first matching email thread
    const emailRow = await gmailPage.$('[data-legacy-thread-id], tr.zA').catch(() => null);
    if (emailRow) {
      await emailRow.click().catch(() => {});
      await gmailPage.waitForTimeout(2000);
    }

    // Find verify/activate/confirm link in the email body
    const verifyLink = await gmailPage.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const hit = links.find(l =>
        /verify|verif|confirm|activate|click here/i.test(l.textContent || l.href) &&
        /workday|myworkday/i.test(l.href)
      );
      return hit ? hit.href : null;
    }).catch(() => null);

    if (verifyLink) {
      console.log('    [workday] found verification link, clicking…');
      await gmailPage.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await gmailPage.waitForTimeout(2000);
    } else {
      console.log('    [workday] no verification link found in Gmail — proceeding anyway');
    }
  } catch (e) {
    console.log('    [workday] Gmail verification error:', e.message.slice(0, 120));
  } finally {
    await gmailPage.close().catch(() => {});
  }
}

// ── Account creation / sign-in ──────────────────────────────────────────────

async function ensureLoggedIn(page, cred, tenant, jobMeta) {
  trace.stage("workday:login", { tenant });
  const url = page.url();
  const context = page.context();

  // Wait for page to settle
  await page.waitForTimeout(2000);

  // Check if already logged in (application form visible)
  const hasApplyForm = await page.$('[data-automation-id="applyButton"], [aria-label*="Apply"], button:has-text("Apply"), [data-automation-id*="MyInformation"]').catch(() => null);
  if (hasApplyForm) {
    console.log('    [workday] already on application form, proceeding');
    return true;
  }

  const alreadyCreated = isAccountCreated(cred.persona || a.persona, tenant);

  // Workday's login/create dialog appears ONLY after clicking the Sign In button.
  // Click it to open the popup, then decide sign-in vs create-account.
  const signInBtn = await page.$('[data-automation-id="utilityButtonSignIn"], [data-automation-id="signInButton"]').catch(() => null);
  if (signInBtn) {
    console.log('    [workday] clicking Sign In button to open dialog…');
    await signInBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Now check the dialog content
  const dialogText = await page.evaluate(() => {
    const dialog = document.querySelector('[data-automation-id="popUpDialog"], [data-automation-id="signInContent"]');
    return dialog ? dialog.innerText.slice(0, 500) : document.body.innerText.slice(0, 1000);
  }).catch(() => '');

  console.log('    [workday] dialog text:', dialogText.slice(0, 200).replace(/\n/g, ' '));

  // Some tenants (First Advantage) open a chooser - Apple / Google / OR / Sign in
  // with email - and show no email or password field, and no Create Account link,
  // until the email option is picked. Do it BEFORE looking for that link: checking
  // first found nothing, so a tenant with no account fell through to a sign-in it
  // could never pass instead of creating one.
  const emailOption = await page.$(`button:has-text("Sign in with email"), a:has-text("Sign in with email")`).catch(() => null);
  if (emailOption && (await emailOption.isVisible().catch(() => false))) {
    console.log(`    [workday] choosing the email sign-in option`);
    await emailOption.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  const hasCreateAccountLink = await page.$('[data-automation-id="createAccountLink"]').catch(() => null);
  const hasEmailInput = await page.$('[data-automation-id="email"]').catch(() => null);

  if (!alreadyCreated && hasCreateAccountLink) {
    console.log('    [workday] creating new account for tenant:', tenant);
    await hasCreateAccountLink.click().catch(() => {});
    await page.waitForTimeout(1500);
    trace.stage("workday:create-account", { tenant });
    await fillCreateAccountForm(page, cred);
    await handleGmailVerification(context);
    await page.waitForTimeout(2000);

    // Only record the account once the page agrees it exists.
    //
    // This marked it created unconditionally. When creation silently failed - an
    // unverified email, a rejected password, a captcha - the flag still went in, so
    // every later job on that tenant skipped creation, went to doSignIn with
    // credentials no account had, and failed. Two tenants were in that exact state.
    if (!(await signedIn(page))) {
      // The commonest reason a create fails is that the account already exists - this
      // persona applied to the tenant before, or an earlier run created it without
      // recording the fact. Workday says nothing useful in that case, so treat a failed
      // create as a cue to sign in rather than as a dead end. Only failing BOTH is a
      // real failure, and succeeding here records the account so we skip create next time.
      console.log(`    [workday] create did not complete - trying sign-in instead`);
      // Reload rather than walking the dialog back. A rejected create leaves it mid-
      // transition, where the sign-in submit measures as not visible and the attempt
      // dies on a second, unrelated symptom. A fresh page is cheap and certain.
      await page.reload({ waitUntil: `domcontentloaded`, timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2500);
      const reSignIn = await page.$(`[data-automation-id="utilityButtonSignIn"], [data-automation-id="signInButton"]`).catch(() => null);
      if (reSignIn) {
        await reSignIn.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2500);
      }
      const reEmail = await page.$(`button:has-text("Sign in with email"), a:has-text("Sign in with email")`).catch(() => null);
      if (reEmail && (await reEmail.isVisible().catch(() => false))) {
        await reEmail.click({ force: true }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      if (await doSignIn(page, cred)) {
        markAccountCreated(cred.persona || a.persona, tenant);
        return true;
      }
      return false;
    }
    markAccountCreated(cred.persona || a.persona, tenant);
    return true;
  }

  // Sign in with existing credentials
  console.log('    [workday] signing in with stored credentials…');
  return await doSignIn(page, cred);
}

// Fill one field by selector, tolerating a selector that matches nothing.
//
// At module scope on purpose. This was a const local to fillCreateAccountForm, and
// doSignIn called it too - so every sign-in threw ReferenceError on the first field,
// before typing anything, and the caught error surfaced as a generic Workday login
// failure. Both callers now share this one.
async function fillSelector(page, sel, val) {
  const el = await page.$(sel).catch(() => null);
  if (el && val) await el.fill(String(val)).catch(() => {});
}
async function fillCreateAccountForm(page, cred) {
  const fill = (sel, val) => fillSelector(page, sel, val);

  // Workday create account form uses data-automation-id attributes
  // Note: some tenants have firstName/lastName, others just have email+password
  await fill('[data-automation-id="firstName"], input[aria-label*="First Name" i], input[name*="firstName" i]', cred.name.split(' ')[0]);
  await fill('[data-automation-id="lastName"], input[aria-label*="Last Name" i], input[name*="lastName" i]', cred.name.split(' ').slice(1).join(' ') || cred.name);
  await fill('[data-automation-id="email"], input[type="email"], input[aria-label*="Email" i]', cred.email);
  await fill('[data-automation-id="password"], input[type="password"][data-automation-id="password"]', cred.password);
  await fill('[data-automation-id="verifyPassword"], input[type="password"][data-automation-id="verifyPassword"]', cred.password);
  // Some fallback for password fields without automation IDs
  const pwInputs = await page.$$('input[type="password"]').catch(() => []);
  if (pwInputs.length >= 1) { try { await pwInputs[0].fill(cred.password); } catch(e) {} }
  if (pwInputs.length >= 2) { try { await pwInputs[1].fill(cred.password); } catch(e) {} }

  // Check consent checkbox if present
  const consentChk = await page.$('[data-automation-id="createAccountCheckbox"], input[type="checkbox"]').catch(() => null);
  if (consentChk && !(await consentChk.isChecked().catch(() => false))) {
    await consentChk.check().catch(() => {});
  }

  await page.waitForTimeout(500);

  // Submit create account form
  const submitBtn = await page.$('[data-automation-id="createAccountSubmitButton"], button[type="submit"], button:has-text("Create Account")').catch(() => null);
  if (submitBtn) {
    // force: true on purpose.
    //
    // The dialog animates in, so Playwright never judges the button stable, click()
    // times out after its default 30s, and the .catch() swallowed the timeout. The run
    // therefore looked like a submit that quietly did nothing: no account was ever
    // created, no request was ever sent, and the failure surfaced much later as an
    // unexplained sign-in failure. With force the POST to /register fires and the
    // dialog closes. A real failure is now logged rather than discarded.
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await submitBtn.click({ timeout: 8000, force: true });
    } catch (e) {
      // Last resort: dispatch the click on the element itself. Workday sometimes leaves
      // a button present but measuring as not visible (a dialog mid-transition), which
      // defeats even force. A direct DOM click still reaches the handler.
      console.log(`    [workday] submit click failed (${String(e.message).slice(0, 60)}) - dispatching directly`);
      trace.fail("submit-click", e);
      await submitBtn.evaluate((el) => el.click()).catch(() => {});
    }
    await page.waitForTimeout(3000);
  }
}

// True when the page shows no sign-in affordance at all - the closest thing to a
// reliable authenticated signal Workday gives without a tenant-specific selector.
async function signedIn(page) {
  const el = await page.$(`[data-automation-id="signInSubmitButton"], [data-automation-id="utilityButtonSignIn"], button:has-text("Sign in with email")`).catch(() => null);
  if (!el) return true;
  return !(await el.isVisible().catch(() => false));
}

async function doSignIn(page, cred) {
  const fill = (sel, val) => fillSelector(page, sel, val);
  // Sign In dialog should already be open (ensureLoggedIn clicked utilityButtonSignIn)
  // If not open, try to open it
  const dialogVisible = await page.$('[data-automation-id="popUpDialog"], [data-automation-id="signInFormo"]').catch(() => null);
  if (!dialogVisible) {
    const signinBtn = await page.$('[data-automation-id="utilityButtonSignIn"], [data-automation-id="signInButton"], a:has-text("Sign In"), button:has-text("Sign In")').catch(() => null);
    if (signinBtn) {
      await signinBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
    }
  };

  await fill('[data-automation-id="email"], input[type="email"], input[aria-label*="Email" i]', cred.email);
  await page.waitForTimeout(300);

  // Some Workday flows have a "Next" step before password
  const nextBtn = await page.$('button:has-text("Next"), [data-automation-id="nextButton"]').catch(() => null);
  if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
    await nextBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  await fill('[data-automation-id="password"], input[type="password"]', cred.password);
  await page.waitForTimeout(300);

  const submitBtn = await page.$('[data-automation-id="signInSubmitButton"], button[type="submit"], button:has-text("Sign In")').catch(() => null);
  if (submitBtn) {
    // force: true on purpose.
    //
    // The dialog animates in, so Playwright never judges the button stable, click()
    // times out after its default 30s, and the .catch() swallowed the timeout. The run
    // therefore looked like a submit that quietly did nothing: no account was ever
    // created, no request was ever sent, and the failure surfaced much later as an
    // unexplained sign-in failure. With force the POST to /register fires and the
    // dialog closes. A real failure is now logged rather than discarded.
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    try {
      await submitBtn.click({ timeout: 8000, force: true });
    } catch (e) {
      // Last resort: dispatch the click on the element itself. Workday sometimes leaves
      // a button present but measuring as not visible (a dialog mid-transition), which
      // defeats even force. A direct DOM click still reaches the handler.
      console.log(`    [workday] submit click failed (${String(e.message).slice(0, 60)}) - dispatching directly`);
      trace.fail("submit-click", e);
      await submitBtn.evaluate((el) => el.click()).catch(() => {});
    }
    await page.waitForTimeout(3000);
  }

  // Check if sign-in succeeded
  const errorText = await page.evaluate(() => {
    const err = document.querySelector('[data-automation-id="errorMessage"], .error, [class*="error"]');
    return err ? err.innerText.slice(0, 200) : '';
  }).catch(() => '');

  if (/invalid|incorrect|wrong|failed/i.test(errorText)) {
    console.log(`    [workday] sign-in rejected: ${errorText.slice(0, 120)}`);
    return false;
  }

  // Verify the sign-in actually took, rather than assuming it did.
  //
  // Workday answers a bad password, an unverified account, or a captcha by leaving
  // the dialog exactly where it is - often with nothing matching the error selectors
  // above. The old code returned true in that case, so the caller walked into an
  // application form that had never loaded and reported step 1: (unknown) and no
  // upload control found. Those are symptoms of never having signed in; say so.
  if (!(await signedIn(page))) {
    console.log(`    [workday] sign-in did not take - still showing a sign-in control`);
    return false;
  }
  return true;
}

// ── Application form fill ───────────────────────────────────────────────────

async function clickApplyButton(page) {
  // Find and click the Apply button on the job posting page
  for (const sel of [
    '[data-automation-id="applyButton"]',
    'button:has-text("Apply")',
    'a:has-text("Apply")',
    '[aria-label*="Apply" i]',
  ]) {
    const btn = await page.$(sel).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(2000);
      return true;
    }
  }
  return false;
}

// Fill a Workday text/textarea input found near a label
async function fillField(page, labelPattern, value) {
  if (!value) return;
  await page.evaluate(({ pat, val }) => {
    const re = new RegExp(pat, 'i');
    // Try data-automation-id text inputs
    const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[type="email"], textarea'));
    for (const inp of allInputs) {
      const label = inp.getAttribute('aria-label') || inp.getAttribute('placeholder') || '';
      const containerText = (inp.closest('[data-automation-id]')?.innerText || inp.closest('label,div,fieldset')?.innerText || '').slice(0, 200);
      if (re.test(label) || re.test(containerText)) {
        if (!inp.value) { inp.value = val; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); }
        return true;
      }
    }
    return false;
  }, { pat: labelPattern, val: String(value) }).catch(() => {});
}

async function fillWorkdayForm(page, jobMeta) {
  trace.stage("workday:form");
  console.log('    [workday] filling application form…');

  // Click Apply button to open the application
  await clickApplyButton(page);
  await page.waitForTimeout(1500);

  // Multi-step: loop through pages until we hit Review/Submit
  let stepCount = 0;
  const MAX_STEPS = 12;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    await page.waitForTimeout(1000);

    const stepTitle = await page.evaluate(() => {
      const h = document.querySelector('[data-automation-id="formHeader"] h2, .css-kgylqn h2, [class*="formHeader"] h2');
      return h ? h.innerText.trim() : '';
    }).catch(() => '');

    console.log(`    [workday] step ${stepCount}: ${stepTitle || '(unknown)'}`);

    // Fill fields based on step name
    if (/my information|personal|contact/i.test(stepTitle) || stepCount === 1) {
      await fillMyInformationStep(page);
    } else if (/work experience|experience/i.test(stepTitle)) {
      await fillWorkExperienceStep(page);
    } else if (/education/i.test(stepTitle)) {
      await fillEducationStep(page);
    } else if (/question|application question|screening/i.test(stepTitle)) {
      await fillScreeningQuestions(page);
    } else if (/self.?identify|voluntary|demographic|disclosure/i.test(stepTitle)) {
      await fillSelfIdentify(page);
    } else if (/review|summary/i.test(stepTitle)) {
      // We're on the review page — done filling, proceed to submit
      break;
    }

    // Also handle generic form fields on any step
    await fillRemainingRequired(page).catch(() => {});
    await handleRadioGroups(page).catch(() => {});

    // Look for Next/Continue/Save button
    const nextBtn = await page.$(
      '[data-automation-id="bottomNavigationNext"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Save and Continue")'
    ).catch(() => null);
    if (!nextBtn || !(await nextBtn.isVisible().catch(() => false))) {
      // Try to find any primary action button
      const anyNext = await page.$('button[data-automation-id*="next" i], button[data-automation-id*="continue" i]').catch(() => null);
      if (!anyNext) break;
      await anyNext.click().catch(() => {});
    } else {
      await nextBtn.click().catch(() => {});
    }
    await page.waitForTimeout(2000);
  }
}

async function fillMyInformationStep(page) {
  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && val && await el.isVisible().catch(() => false)) {
      const cur = await el.inputValue().catch(() => '');
      if (!cur) await el.fill(String(val)).catch(() => {});
    }
  };

  // Legal name
  await fill('[data-automation-id="legalNameSection_firstName"], input[aria-label*="First Name" i]', a.firstName);
  await fill('[data-automation-id="legalNameSection_lastName"], input[aria-label*="Last Name" i]', a.lastName);
  // Address / contact
  await fill('[data-automation-id="addressSection_addressLine1"], input[aria-label*="Address Line 1" i]', a.addressLine1 || a.city);
  await fill('[data-automation-id="addressSection_city"], input[aria-label*="City" i]', a.city);
  await fill('[data-automation-id="addressSection_postalCode"], input[aria-label*="Postal Code" i], input[aria-label*="Zip" i]', a.zip || '');
  await fill('[data-automation-id="phone-number"], input[aria-label*="Phone" i]', a.phoneDigits);
  await fill('input[data-automation-id*="email" i]', a.email);

  // Resume upload
  trace.stage("workday:resume");
  const up = await attachResume(page, page, a.resumePath);
  if (!up.ok) console.log('    [workday] resume upload issue:', up.result.reason);

  // Work authorization dropdowns (Workday uses native selects or custom widgets)
  await fillWorkdayDropdown(page, /authorized.*(work|employment)|work.*(authorized|authorization)|eligible to work/i, 'Yes');
  await fillWorkdayDropdown(page, /require.*sponsorship|sponsorship.*visa|visa.*sponsorship/i, 'No');
  await fillWorkdayDropdown(page, /country/i, 'United States');
  if (a.stateFull) await fillWorkdayDropdown(page, /state|province/i, a.stateFull);
}

async function fillWorkExperienceStep(page) {
  // Workday often pre-populates from resume parse; only fill if empty
  await page.waitForTimeout(500);
  // If there's an "Add Work Experience" button and it's empty, we might need to add entries
  // Skip for now — Workday's resume parse usually handles this
  console.log('    [workday] work experience step — relying on resume parse');
}

async function fillEducationStep(page) {
  console.log('    [workday] education step — relying on resume parse');
}

async function fillScreeningQuestions(page) {
  // Fill text/textarea questions
  for (const el of await page.$$('input[type="text"]:not([aria-hidden="true"]), textarea:not([aria-hidden="true"])')) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const cur = await el.inputValue().catch(() => '');
    if (cur) continue;
    const label = await el.evaluate(e => {
      const lbl = e.getAttribute('aria-label') || e.getAttribute('placeholder') || '';
      const container = e.closest('[data-automation-id]') || e.closest('div');
      return lbl || (container ? container.innerText.slice(0, 200) : '');
    }).catch(() => '');
    if (!label) continue;

    // Yes/No phrased
    if (/^(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\b/i.test(label)) {
      const yn = yesNoForLabel(label, a);
      if (yn) { await el.fill(yn).catch(() => {}); continue; }
    }
    const ans = generateAnswer(label, a);
    if (ans) await el.fill(ans.slice(0, 1000)).catch(() => {});
  }

  // Handle radio groups
  await handleRadioGroups(page).catch(() => {});

  // Native selects
  for (const sel of await page.$$('select')) {
    const cur = await sel.evaluate(e => e.value).catch(() => '');
    if (cur && !/^$|select|choose/i.test(cur)) continue;
    const label = await sel.evaluate(e => (e.closest('div,fieldset')?.innerText || '').slice(0, 200)).catch(() => '');
    await fillWorkdayDropdown(page, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), null, sel);
  }
}

async function fillSelfIdentify(page) {
  // EEO/voluntary self-ID — use radio groups handler + dropdown logic
  await handleRadioGroups(page).catch(() => {});
  // Every answer comes from the persona (src/util/eeo.js) — never a default demographic.
  const EEO = [[/gender/i, 'gender'], [/hispanic|latino/i, 'hispanic'], [/race|ethnicity/i, 'race'], [/veteran/i, 'veteran'], [/disab/i, 'disability']];
  for (const [labelRe, kind] of EEO) await fillWorkdayDropdown(page, labelRe, eeoValue(kind, a), null, kind);
}

// Fill a Workday dropdown (native select or custom widget) matching a label regex.
// `eeoKind`, when given, picks from the native options via pickEeo instead of matching
// preferredValue. Values match on word boundaries so "Male" never selects "Female".
async function fillWorkdayDropdown(page, labelRe, preferredValue, directEl, eeoKind) {
  const el = directEl || await page.evaluate((pattern) => {
    const re = new RegExp(pattern, 'i');
    const selects = Array.from(document.querySelectorAll('select'));
    return selects.find(s => {
      const label = s.getAttribute('aria-label') || (s.closest('div,label')?.innerText || '').slice(0, 200);
      return re.test(label);
    }) ? true : false; // can't return DOM element across evaluate boundary
  }, labelRe.source).catch(() => false);

  if (!el && !directEl) return;

  // Try native select first
  for (const sel of await page.$$('select')) {
    const label = await sel.evaluate(e => {
      return e.getAttribute('aria-label') || (e.closest('div,label,fieldset')?.innerText || '').slice(0, 200);
    }).catch(() => '');
    if (!labelRe.test(label)) continue;
    const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim()));
    let pick = eeoKind
      ? pickEeo(eeoKind, opts.filter(o => o && !/^(select|choose)\b/i.test(o)), a)
      : (preferredValue ? opts.find(o => new RegExp('\\b' + preferredValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(o)) : null);
    if (!pick) {
      // Smart defaults
      if (/yes/i.test(preferredValue || '')) pick = opts.find(o => /^yes\b/i.test(o));
      if (/no/i.test(preferredValue || '')) pick = opts.find(o => /^no\b/i.test(o));
    }
    if (pick) await sel.selectOption({ label: pick }).catch(() => {});
    return;
  }

  // Workday custom dropdown widget
  await page.evaluate(({ pattern, val }) => {
    const re = new RegExp(pattern, 'i');
    const btns = Array.from(document.querySelectorAll('[data-automation-id*="select" i], [role="combobox"], [role="listbox"]'));
    for (const btn of btns) {
      const label = (btn.getAttribute('aria-label') || btn.closest('div')?.innerText || '').slice(0, 200);
      if (!re.test(label)) continue;
      btn.click();
      setTimeout(() => {
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        const hit = val ? opts.find(o => new RegExp('\\b' + val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(o.textContent || '')) : opts[1];
        if (hit) hit.click();
      }, 400);
      break;
    }
  }, { pattern: labelRe.source, val: preferredValue || '' }).catch(() => {});
  await page.waitForTimeout(600);
}

// ── Main export ─────────────────────────────────────────────────────────────

async function applyWorkday(page, jobMeta, answers, opts) {
  // `jobMeta` may be passed as the second arg (old 2-arg call pattern) or we
  // use page.url() when only a URL string was supplied (matches other handlers).
  const url = (typeof jobMeta === 'string' ? jobMeta : (jobMeta && jobMeta.url)) || page.url();
  const meta = typeof jobMeta === 'object' && jobMeta !== null ? jobMeta : { url };

  const tenant = tenantKey(url);
  const persona = (answers && answers.persona) || a.persona;
  let cred;
  try { cred = getCredentials(persona); }
  catch (e) { return { status: 'Error', reason: e.message }; }
  cred.persona = persona;

  console.log(`    [workday] tenant: ${tenant}`);

  // Navigate and log in / create account
  try {
    const loggedIn = await ensureLoggedIn(page, cred, tenant, meta);
    if (!loggedIn) {
      return { status: 'Error', reason: 'Workday sign-in failed — invalid credentials or unexpected page state' };
    }
  } catch (e) {
    return { status: 'Error', reason: 'Workday login error: ' + e.message.slice(0, 200) };
  }

  // Navigate back to the job URL if login redirected away
  const currentUrl = page.url();
  if (!currentUrl.includes(tenant) && url !== currentUrl) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }

  // Skip non-US postings
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bUK\b|\bUnited Kingdom\b|\bGermany\b|\bLondon\b/i.test(bodyText)) {
    return { status: 'Skipped', reason: 'Non-US Workday posting' };
  }

  // Fill the application first (then review gate before submit)
  try {
    await fillWorkdayForm(page, meta);
  } catch (e) {
    return { status: 'Error', reason: 'Form fill error: ' + e.message.slice(0, 200) };
  }

  // Pre-submit review gate (after form is filled)
  trace.stage("workday:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: answers || a, jobMeta: meta }).catch(() => null);
  if (reviewBlock) return reviewBlock;

  // DRY_RUN: stop before submit
  if (process.env.DRY_RUN) {
    const shot = path.resolve(__dirname, `../../.state/dry-run-workday-${tenant}-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { status: 'DryRun', reason: `Workday form filled — screenshot ${shot}` };
  }

  // Submit — wait up to 10s for the button to appear (Workday SPA needs time)
  let submitBtn = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    submitBtn = await page.$(
      '[data-automation-id="bottomNavigationSubmit"], [data-automation-id="submitButton"], ' +
      'button:has-text("Submit"), button:has-text("Submit Application"), ' +
      'button[data-automation-id*="submit" i], [class*="submit" i] button'
    ).catch(() => null);
    if (submitBtn && await submitBtn.isVisible().catch(() => false)) break;
    submitBtn = null;
    await page.waitForTimeout(1000);
  }
  if (!submitBtn) {
    // Try clicking any review-page Submit button by evaluate
    const hasSubmit = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const sb = btns.find(b => /^submit/i.test(b.innerText.trim()) && b.offsetParent !== null);
      if (sb) { sb.click(); return true; }
      return false;
    }).catch(() => false);
    if (!hasSubmit) return { status: 'Error', reason: 'Workday submit button not found' };
    // If we clicked it via evaluate, wait for confirmation
    const CONFIRM2 = /thank you|application (submitted|received|complete)|we.ve received your application|application.*success/i;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(2500);
      if (/confirmation|success|thank.?you/i.test(page.url())) return { status: 'Applied', reason: '—' };
      const txt2 = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
      if (CONFIRM2.test(txt2)) return { status: 'Applied', reason: '—' };
    }
    return { status: 'Error', reason: 'No Workday confirmation after submit (evaluate click)' };
  }

  await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(300);
  await submitBtn.click({ timeout: 10000 }).catch(async () => {
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => /submit/i.test(x.innerText));
      b && b.click();
    }).catch(() => {});
  });

  // Poll for confirmation
  const CONFIRM = /thank you|application (submitted|received|complete)|we.ve received your application|application.*success/i;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2500);
    if (/confirmation|success|thank.?you/i.test(page.url())) return { status: 'Applied', reason: '—' };
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(txt)) return { status: 'Applied', reason: '—' };
  }

  return { status: 'Error', reason: 'No Workday confirmation after submit' };
}

module.exports = { applyWorkday };
