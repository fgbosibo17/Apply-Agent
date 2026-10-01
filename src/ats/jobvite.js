// Jobvite ATS handler.
// Jobvite career pages: jobs.jobvite.com/<company>/job/<jobid>
// Requires account creation (email + password) per company.
// Uses persona credentials from data/ats-accounts.json.
//
// Flow:
//   1. Navigate to job URL
//   2. Click "APPLY" link → navigates to /apply path on same domain
//   3. Sign in with stored credentials (or create account)
//   4. Upload resume via "SELECT" button (triggers file chooser) or direct file-input-0
//   5. Fill personal info fields
//   6. Click "NEXT →" button to advance
//   7. Click "Send Application" to submit
//   8. Confirm
//
// FIX 2026-09-12:
// - Resume upload was failing because handler used generic input[type=file] selectors.
//   Jobvite uses a "SELECT" button (class=jv-button) that triggers a file chooser.
//   The hidden input is #file-input-0. Must use filechooser strategy.
// - Submit: Jobvite has a 2-step flow: "NEXT →" advances the form, then
//   "Send Application" (type=submit, ng-hide removed when form is complete) submits.
// - Form fields use dynamic IDs like "jv-field-xxxx" — fill by label proximity.

const path = require('path');
const fs   = require('fs');
const { pickEeo } = require('../util/eeo');
const a    = require('../answers');
const { generateAnswer } = require('../answer-bank');
const { fillRemainingRequired, handleRadioGroups, dryRunShotPath } = require('../util/form');
const { attachResume } = require('../resume/upload');
const { gateBeforeSubmit } = require('../util/answer-review');
const { yesNoForLabel } = require('../util/answers-map');

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

function isJobviteAccountCreated(persona) {
  const data = loadAccounts();
  return !!((data.accounts_created || {})[`jobvite:${persona}`]);
}

function markJobviteAccountCreated(persona) {
  const data = loadAccounts();
  if (!data.accounts_created) data.accounts_created = {};
  data.accounts_created[`jobvite:${persona}`] = {
    created: true,
    createdAt: new Date().toISOString(),
  };
  saveAccounts(data);
}

// ── Gmail verification ──────────────────────────────────────────────────────

async function handleGmailVerification(context) {
  console.log('    [jobvite] opening Gmail to find verification email…');
  const gmailPage = await context.newPage();
  try {
    await gmailPage.goto('https://mail.google.com/mail/u/0/#search/from%3Ajobvite+newer_than%3A5m+verify', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await gmailPage.waitForTimeout(3000);

    const emailRow = await gmailPage.$('[data-legacy-thread-id], tr.zA').catch(() => null);
    if (emailRow) {
      await emailRow.click().catch(() => {});
      await gmailPage.waitForTimeout(2000);
    }

    const verifyLink = await gmailPage.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      const hit = links.find(l =>
        /verify|verif|confirm|activate|click here/i.test(l.textContent || l.href) &&
        /jobvite|jobs\.jobvite/i.test(l.href)
      );
      return hit ? hit.href : null;
    }).catch(() => null);

    if (verifyLink) {
      console.log('    [jobvite] found verification link, clicking…');
      await gmailPage.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await gmailPage.waitForTimeout(2000);
    } else {
      console.log('    [jobvite] no verification link found — proceeding');
    }
  } catch (e) {
    console.log('    [jobvite] Gmail verification error:', e.message.slice(0, 120));
  } finally {
    await gmailPage.close().catch(() => {});
  }
}

// ── Account creation / sign-in ──────────────────────────────────────────────

async function ensureLoggedIn(page, cred) {
  const context = page.context();
  await page.waitForTimeout(1500);

  const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
  const alreadyCreated = isJobviteAccountCreated(cred.persona || a.persona);

  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && val) await el.fill(String(val)).catch(() => {});
  };

  // Already on application form
  const hasForm = await page.$('.jv-file-list, [class*=jv-resume], button.jv-button').catch(() => null);
  if (hasForm) {
    console.log('    [jobvite] already on application form');
    return true;
  }

  // Check for sign-in form
  const hasSignInForm = /sign in|log in|login/i.test(pageText) && !/create account|register|sign up/i.test(pageText);

  if (alreadyCreated || hasSignInForm) {
    console.log('    [jobvite] signing in…');
    await fill('input[type="email"], input[name="email"], input[id*="email"]', cred.email);
    await fill('input[type="password"], input[name="password"], input[id*="password"]', cred.password);
    await page.waitForTimeout(300);
    const signinBtn = await page.$('button:has-text("Sign In"), button:has-text("Log In"), button[type="submit"]').catch(() => null);
    if (signinBtn) {
      await signinBtn.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
    return true;
  }

  // Create new account
  console.log('    [jobvite] creating new account…');
  const createBtn = await page.$('button:has-text("Create Account"), button:has-text("Sign Up"), button:has-text("Register"), a:has-text("Create Account")').catch(() => null);
  if (createBtn) {
    await createBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
  }

  await fill('input[type="email"], input[name="email"], input[id*="email"]', cred.email);
  await fill('input[type="password"]:not([id*="onfirm" i]):not([name*="onfirm" i])', cred.password);
  await fill('input[id*="confirm" i][type="password"], input[name*="confirm" i][type="password"]', cred.password);

  const nameField = await page.$('input[name="name"], input[id*="fullName"], input[placeholder*="Full Name" i]').catch(() => null);
  if (nameField) {
    await nameField.fill(cred.name).catch(() => {});
  } else {
    await fill('input[name*="firstName" i], input[id*="firstName" i]', cred.name.split(' ')[0]);
    await fill('input[name*="lastName" i], input[id*="lastName" i]', cred.name.split(' ').slice(1).join(' ') || cred.name);
  }

  await page.waitForTimeout(300);
  const submitBtn = await page.$('button[type="submit"], button:has-text("Create Account"), button:has-text("Sign Up")').catch(() => null);
  if (submitBtn) {
    await submitBtn.click().catch(() => {});
    await page.waitForTimeout(4000);
    await handleGmailVerification(context);
    await page.waitForTimeout(2000);
    markJobviteAccountCreated(cred.persona || a.persona);
  }

  return true;
}

// ── Resume upload for Jobvite ──────────────────────────────────────────────

async function uploadJobviteResume(page) {
  console.log('    [jobvite] uploading resume…');

  // Strategy 1: Direct setInputFiles on #file-input-0
  const fileInput = await page.$('#file-input-0, input[type="file"]').catch(() => null);
  if (fileInput) {
    try {
      await fileInput.setInputFiles(a.resumePath);
      await page.waitForTimeout(2000);

      // Check if upload was acknowledged
      const body = await page.evaluate(() => document.body.innerText).catch(() => '');
      const resumeBasename = require('path').basename(a.resumePath);
      if (body.includes(resumeBasename) || body.includes(resumeBasename.replace(/\.pdf$/i, ''))) {
        console.log('    [jobvite] resume uploaded via file input');
        return true;
      }
    } catch (e) {
      console.log('    [jobvite] file input strategy failed:', e.message.slice(0, 100));
    }
  }

  // Strategy 2: Click "SELECT" button and handle file chooser
  for (const sel of [
    'button.jv-button.ng-isolate-scope:has-text("SELECT")',
    'button:has-text("SELECT")',
    'button:has-text("Add Resume")',
    'button:has-text("Upload Resume")',
    'button:has-text("Attach")',
    'button:has-text("Choose")',
    '.jv-upload-resume button',
    '[class*=resume] button',
    '.jv-button:first-child',
  ]) {
    const btn = await page.$(sel).catch(() => null);
    if (!btn || !(await btn.isVisible().catch(() => false))) continue;

    console.log('    [jobvite] trying file chooser via:', sel);
    try {
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
        btn.click().catch(() => {}),
      ]);

      if (chooser) {
        await chooser.setFiles(a.resumePath);
        await page.waitForTimeout(2000);
        console.log('    [jobvite] resume uploaded via file chooser');
        return true;
      }
    } catch (e) {
      console.log('    [jobvite] chooser strategy failed:', e.message.slice(0, 100));
    }
  }

  // Strategy 3: attachResume utility
  trace.stage("jobvite:resume");
  const up = await attachResume(page, page, a.resumePath, {
    selectors: ['input[type="file"]', '#file-input-0'],
    buttonTexts: ['SELECT', 'Add Resume', 'Upload Resume', 'Attach', 'Choose File'],
    buttonSelectors: [
      'button.jv-button:has-text("SELECT")',
      'button:has-text("SELECT")',
      '.jv-apply-section button:first-child',
    ],
  });
  if (up.ok) {
    console.log('    [jobvite] resume uploaded via attachResume utility');
    return true;
  }

  console.log('    [jobvite] resume upload failed:', up.result && up.result.reason);
  return false;
}

// ── Fill form fields by label proximity ────────────────────────────────────

async function fillJobviteField(page, labelPattern, value) {
  if (!value) return false;
  // Try to find an input near a label matching the pattern
  return await page.evaluate(({ pat, val }) => {
    const re = new RegExp(pat, 'i');
    const labels = Array.from(document.querySelectorAll('label, .jv-label, [class*=label]'));
    for (const lbl of labels) {
      if (!re.test(lbl.innerText || '')) continue;
      const forId = lbl.getAttribute('for');
      let input = forId ? document.getElementById(forId) : null;
      if (!input) {
        // Look for sibling or child input
        input = lbl.nextElementSibling?.tagName === 'INPUT' ? lbl.nextElementSibling :
                lbl.querySelector('input, textarea, select') ||
                lbl.parentElement?.querySelector('input, textarea, select');
      }
      if (input && !input.value) {
        input.value = val;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }, { pat: labelPattern, val: String(value) }).catch(() => false);
}

// ── Main handler ──────────────────────────────────────────────────────────────

const trace = require("../util/trace");
async function applyJobvite(page, jobMeta) {
  trace.stage("jobvite");
  console.log('    [jobvite] starting application…');
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

  const cred = getCredentials(a.persona);

  // ── Navigate to /apply path ────────────────────────────────────────────────
  const currentUrl = page.url();

  // If on job listing page (not already on /apply), click the APPLY link
  if (!currentUrl.includes('/apply')) {
    // Try clicking APPLY link first
    for (const sel of [
      'a:has-text("APPLY")', 'a:has-text("Apply")', 'a:has-text("Apply Now")',
      'button:has-text("APPLY")', 'button:has-text("Apply")',
      'a[href*="/apply"]', 'a[class*="apply" i]',
    ]) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        const href = await btn.getAttribute('href').catch(() => '');
        console.log('    [jobvite] clicking apply link, href:', href);
        await btn.click().catch(() => {});
        await page.waitForTimeout(3000);
        // Check if we navigated to /apply
        if (page.url().includes('/apply')) break;
      }
    }

    // If still not on /apply, navigate directly
    if (!page.url().includes('/apply')) {
      const applyUrl = currentUrl.split('?')[0].replace(/\/?$/, '') + '/apply';
      console.log('    [jobvite] navigating directly to:', applyUrl);
      await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }

  console.log('    [jobvite] on apply page:', page.url());

  // ── Ensure logged in / account created ────────────────────────────────────
  const loggedIn = await ensureLoggedIn(page, cred);
  if (!loggedIn) return { status: 'Error', reason: 'Could not authenticate with Jobvite' };

  // Wait for application form (AngularJS, can be slow)
  await page.waitForTimeout(2000);
  await page.waitForSelector('button.jv-button, input[type="file"], .jv-file-list, input[id^="jv-field"]', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1000);

  const fill = async (sel, val) => {
    const el = await page.$(sel).catch(() => null);
    if (el && val) {
      await el.scrollIntoViewIfNeeded().catch(() => {});
      const cur = await el.inputValue().catch(() => '');
      if (!cur) await el.fill(String(val)).catch(() => {});
    }
  };

  // ── Resume upload ──────────────────────────────────────────────────────────
  const resumeUploaded = await uploadJobviteResume(page);
  if (!resumeUploaded) {
    return { status: 'Error', reason: 'Jobvite resume upload failed — no file chooser or file input found' };
  }

  // ── Fill personal info ─────────────────────────────────────────────────────
  // Jobvite uses dynamic IDs (jv-field-xxxx), so fill by label or position
  await fillJobviteField(page, 'first\\s*name', a.firstName);
  await fillJobviteField(page, 'last\\s*name', a.lastName);
  await fillJobviteField(page, 'email', a.email);
  await fillJobviteField(page, 'phone|cell', a.phoneDigits);
  await fillJobviteField(page, 'linkedin|social', a.linkedIn);
  await fillJobviteField(page, 'city', a.city);
  await fillJobviteField(page, 'state', a.state);
  await fillJobviteField(page, 'zip|postal', a.zip);

  // Also try direct fills with common input IDs
  await fill('input[id^="jv-field-"]:nth-of-type(1)', a.firstName);

  // Selects
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
    } else if (/gender/i.test(label)) {
      const m = pickEeo('gender', opts, a);
      if (m) await sel.selectOption({ label: m }).catch(() => {});
    } else if (/veteran/i.test(label)) {
      const v = pickEeo('veteran', opts, a);
      if (v) await sel.selectOption({ label: v }).catch(() => {});
    } else if (/how did you|hear about/i.test(label)) {
      const li = opts.find(o => /linkedin/i.test(o)) || opts.find(o => /other/i.test(o));
      if (li) await sel.selectOption({ label: li }).catch(() => {});
    }
  }

  // Custom textareas
  for (const ta of await page.$$('textarea')) {
    if (!(await ta.isVisible().catch(() => false))) continue;
    const taId = await ta.getAttribute('id').catch(() => '');
    if (taId && /jv-edit-resume|jv-paste-resume/i.test(taId)) continue; // skip resume paste areas
    if (await ta.inputValue().catch(() => '')) continue;
    const label = await ta.evaluate(el => {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const lbl = p.querySelector('label, .question-label, .form-label')?.innerText?.trim();
        if (lbl) return lbl.slice(0, 240);
        p = p.parentElement;
      }
      return '';
    }).catch(() => '');
    if (/cover letter/i.test(label) && !/\*/.test(label)) continue;
    if (/^\s*(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\b/i.test(label)) {
      const yn = yesNoForLabel(label, a);
      if (yn) { await ta.fill(yn).catch(() => {}); continue; }
    }
    const ans = generateAnswer(label, a);
    if (ans) await ta.fill(ans).catch(() => {});
  }

  await handleRadioGroups(page).catch(() => {});
  await fillRemainingRequired(page).catch(() => {});

  trace.stage("jobvite:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: a, jobMeta });
  if (reviewBlock) return reviewBlock;

  // ── Navigation: NEXT → then Send Application ───────────────────────────────
  // Jobvite has a 2-step navigation: NEXT → advances to page 2, Send Application submits

  if (process.env.DRY_RUN) {
    const fname = dryRunShotPath((jobMeta && jobMeta.company) || 'jobvite');
    await page.screenshot({ path: fname, fullPage: true }).catch(() => {});
    return { status: 'DryRun', reason: 'all required filled — screenshot ' + fname };
  }

  // Click NEXT → if present
  const nextBtn = await page.$('button.jv-button-primary:has-text("NEXT"), button:has-text("NEXT →"), button:has-text("Next →"), button:has-text("Next")').catch(() => null);
  if (nextBtn && await nextBtn.isVisible().catch(() => false)) {
    console.log('    [jobvite] clicking NEXT button…');
    await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await nextBtn.click().catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Now find Send Application button (may have ng-hide removed after NEXT)
  // Try multiple times as AngularJS may take time to update
  let submitBtn = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    submitBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'));
      // Find "Send Application" button that is NOT hidden
      return btns.find(b => {
        const txt = (b.innerText || b.value || '').toLowerCase();
        const isHidden = b.classList.contains('ng-hide') || b.style.display === 'none' || b.offsetParent === null;
        return (txt.includes('send application') || txt.includes('submit application') || txt.includes('apply')) && !isHidden;
      }) ? true : false;
    }).catch(() => false);

    if (submitBtn) break;
    await page.waitForTimeout(1000);
  }

  if (!submitBtn) {
    // Try clicking any visible submit
    const anySubmit = await page.$('button[type="submit"]:not(.ng-hide), button:has-text("Send Application"), button:has-text("Submit Application")').catch(() => null);
    if (!anySubmit) return { status: 'Error', reason: 'Jobvite submit button not found after NEXT' };
    await anySubmit.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    await anySubmit.click({ timeout: 10000 }).catch(() => {});
  } else {
    // Use evaluate to click it
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'));
      const btn = btns.find(b => {
        const txt = (b.innerText || b.value || '').toLowerCase();
        return txt.includes('send') || txt.includes('submit') || txt.includes('apply');
      });
      if (btn) btn.click();
    }).catch(() => {});
  }

  // Wait for confirmation
  const CONFIRM = /thank you|application (received|submitted|complete)|your application|submitted successfully|we.ve received|thanks for applying/i;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(body)) return { status: 'Applied', reason: '—' };
    if (/\/confirmation|\/success|\/thank/.test(page.url())) return { status: 'Applied', reason: '—' };
  }
  return { status: 'Error', reason: 'No Jobvite confirmation after submit' };
}

module.exports = { applyJobvite };
