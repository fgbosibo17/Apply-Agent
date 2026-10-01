// iCIMS ATS handler.
// iCIMS uses a SaaS portal: jobs.icims.com/<company>/jobs/<jobid> or
// <company>.icims.com/jobs/<jobid>. Each company's portal is a separate tenant
// but they all share the iCIMS account system — one account per email works
// across ALL tenants (once verified). This handler creates or logs into the
// account, then fills the multi-step application.
//
// ARCHITECTURE (critical):
// The iCIMS job page wraps its content in an iframe named "icims_content_iframe".
// The main page shows only "Skip Branding". ALL interaction must happen through
// that iframe. After clicking Apply, the iframe navigates to a /login page.
//
// Flow:
//   1. Navigate to the job URL
//   2. Access the icims_content_iframe
//   3. Click "Apply" button inside the iframe → navigates to /login in the iframe
//   4. Log in or create account inside the iframe
//   5. Fill: Contact Information → Upload Resume → Screening Questions → Submit
//   6. Confirm submission
//
// FIX 2026-09-12: Handler was operating on `page` directly, missing the iframe wrapper.
// All clicks and form fills must go through the icims_content_iframe frame.

const path = require('path');
const fs   = require('fs');
const a    = require('../answers');
const { generateAnswer }       = require('../answer-bank');
const { fillRemainingRequired, handleRadioGroups } = require('../util/form');
const { attachResume }         = require('../resume/upload');
const { gateBeforeSubmit }     = require('../util/answer-review');
const { yesNoForLabel }        = require('../util/answers-map');
const { pickEeo }              = require('../util/eeo');

// ── Credential helpers ─────────────────────────────────────────────────────

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

function isIcimsAccountCreated(persona) {
  const data = loadAccounts();
  return !!((data.accounts_created || {})[`icims:${persona}`]);
}

function markIcimsAccountCreated(persona) {
  const data = loadAccounts();
  if (!data.accounts_created) data.accounts_created = {};
  data.accounts_created[`icims:${persona}`] = {
    created: true,
    createdAt: new Date().toISOString(),
  };
  saveAccounts(data);
}

// ── iCIMS iframe helper ────────────────────────────────────────────────────

// Get the iCIMS content iframe. iCIMS wraps everything in an iframe named
// "icims_content_iframe". Returns the Frame object or falls back to page.
async function getIcimsFrame(page) {
  // Try by name first
  const namedFrame = page.frame({ name: 'icims_content_iframe' });
  if (namedFrame) return namedFrame;

  // Try by URL pattern
  const frames = page.frames();
  for (const f of frames) {
    const url = f.url();
    if (url.includes('icims.com') && url.includes('in_iframe')) {
      return f;
    }
  }
  // Some iCIMS portals don't use the wrapper, fall back to page
  return page;
}

// Wait for the iframe to load and stabilize
async function waitForIcimsFrame(page, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = await getIcimsFrame(page);
    if (frame !== page) return frame;
    const iframe = await page.$('iframe#icims_content_iframe, iframe[name="icims_content_iframe"]').catch(() => null);
    if (iframe) {
      // Navigate the iframe src directly
      const src = await iframe.getAttribute('src').catch(() => null);
      if (src && !src.includes('in_iframe')) {
        // Force load in_iframe version
        const inIframeSrc = src.includes('?') ? src + '&in_iframe=1' : src + '?in_iframe=1';
        await page.evaluate((s) => {
          const f = document.getElementById('icims_content_iframe') || document.querySelector('iframe[name="icims_content_iframe"]');
          if (f) f.src = s;
        }, inIframeSrc).catch(() => {});
        await page.waitForTimeout(2000);
      }
      return await getIcimsFrame(page);
    }
    await page.waitForTimeout(500);
  }
  return page; // fallback
}

// ── Gmail verification ──────────────────────────────────────────────────────

async function handleGmailVerification(context, fromPattern) {
  console.log('    [icims] opening Gmail to find verification email…');
  const gmailPage = await context.newPage();
  try {
    const query = encodeURIComponent(`from:${fromPattern || 'icims'} newer_than:5m verify`);
    await gmailPage.goto(`https://mail.google.com/mail/u/0/#search/${query}`, {
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
        /icims|taleo|jobs\./i.test(l.href)
      );
      return hit ? hit.href : null;
    }).catch(() => null);

    if (verifyLink) {
      console.log('    [icims] found verification link, clicking…');
      await gmailPage.goto(verifyLink, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await gmailPage.waitForTimeout(2000);
    } else {
      console.log('    [icims] no verification link found — proceeding');
    }
  } catch (e) {
    console.log('    [icims] Gmail verification error:', e.message.slice(0, 120));
  } finally {
    await gmailPage.close().catch(() => {});
  }
}

// ── Account login / create ─────────────────────────────────────────────────

async function ensureIcimsLoggedIn(page, cred, persona) {
  const context = page.context();
  const frame = await waitForIcimsFrame(page);
  await page.waitForTimeout(1000);

  const frameText = await frame.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');

  // Already applied check
  if (/already applied|you have applied|application submitted/i.test(frameText)) {
    return { status: 'Skipped', reason: 'Already applied to this iCIMS job' };
  }

  // Click the Apply button inside the iframe
  const applyBtn = await frame.$(
    'a.iCIMS_ApplyOnlineButton, a:has-text("Apply Now"), a:has-text("Apply"), button:has-text("Apply")'
  ).catch(() => null);

  if (applyBtn) {
    console.log('    [icims] clicking Apply button in iframe…');
    await applyBtn.click().catch(() => {});
    await page.waitForTimeout(3000);
  }

  // Now we should be on the login page inside the iframe
  const loginFrame = await getIcimsFrame(page);
  const loginText = await loginFrame.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '');

  console.log('    [icims] login page text:', loginText.slice(0, 200).replace(/\n/g, ' '));

  // iCIMS login flow: enter email first, then password or create account
  const emailInput = await loginFrame.$('input#email, input[name="css_loginName"], input[type="email"]').catch(() => null);
  if (emailInput) {
    console.log('    [icims] filling email…');
    await emailInput.fill(cred.email).catch(() => {});
    await page.waitForTimeout(300);

    // Accept GDPR consent if present
    const gdprCheckbox = await loginFrame.$('#accept_gdpr, input[name="accept_gdpr"]').catch(() => null);
    if (gdprCheckbox && !(await gdprCheckbox.isChecked().catch(() => false))) {
      await gdprCheckbox.check().catch(() => {});
    }

    // Submit email - then wait for URL change in the iframe
    const emailSubmit = await loginFrame.$('#enterEmailSubmitButton, input[type="submit"], button[type="submit"]').catch(() => null);
    if (emailSubmit) {
      console.log('    [icims] clicking email submit button…');
      const loginFrameUrlBefore = loginFrame.url();
      await emailSubmit.click().catch(() => {});
      
      // Wait for the iframe to navigate to a new URL (password page or verification page)
      // Poll for URL change for up to 10 seconds
      let urlChanged = false;
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(500);
        try {
          const currentFrames = page.frames();
          for (const f of currentFrames) {
            const furl = f.url();
            if (furl.includes('icims.com') && furl !== loginFrameUrlBefore && furl.includes('in_iframe')) {
              console.log('    [icims] iframe URL changed to:', furl.slice(0, 100));
              urlChanged = true;
              break;
            }
          }
          if (urlChanged) break;
        } catch(e) {}
      }
      
      if (!urlChanged) {
        console.log('    [icims] URL did not change after email submit — checking current state');
      }
    }
  }

  // Get fresh frame state after email submission
  await page.waitForTimeout(2000);
  
  // Find the best iCIMS frame with actual content
  let loginFrame2 = page;
  for (const f of page.frames()) {
    try {
      const ft = await f.evaluate(() => document.body.innerText.trim()).catch(() => '');
      const furl = f.url();
      if (furl.includes('icims.com') && ft && ft !== 'Skip Branding' && ft.length > 20) {
        loginFrame2 = f;
        console.log('    [icims] found content frame:', furl.slice(0, 100));
        break;
      }
    } catch(e) {}
  }
  
  const postEmailText = await loginFrame2.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '');
  console.log('    [icims] post-email page text (first 300):', postEmailText.slice(0, 300).replace(/\n/g, ' '));

  const hasPassword = await loginFrame2.$('input[type="password"], input[name="css_password"]').catch(() => null);
  const hasCreateAccount = /create.*account|register|sign up|new.*account/i.test(postEmailText);
  const hasEmailVerification = /check.*email|verification.*email|email.*sent|verify.*email|email.*check/i.test(postEmailText);
  const alreadyCreated = isIcimsAccountCreated(persona);

  // Check if we're stuck because of hCaptcha blocking the login step
  const captchaActive = page.frames().some(f => f.url().includes('hcaptcha.com'));
  if (captchaActive && !hasPassword && !hasCreateAccount && !hasEmailVerification) {
    console.log('    [icims] hCaptcha is blocking login — cannot proceed automatically');
    return { status: 'Skipped', reason: 'iCIMS requires captcha completion — manual login needed' };
  }
  
  console.log('    [icims] state check: alreadyCreated=', alreadyCreated, '| hasPassword=', !!hasPassword, '| hasCreateAccount=', hasCreateAccount, '| hasEmailVerification=', hasEmailVerification);

  if (hasPassword) {
    // Fill password (existing account)
    console.log('    [icims] filling password…');
    await hasPassword.fill(cred.password).catch(() => {});
    await page.waitForTimeout(300);

    const pwSubmit = await loginFrame2.$('input[type="submit"], button[type="submit"], button:has-text("Sign In"), button:has-text("Log In")').catch(() => null);
    if (pwSubmit) {
      await pwSubmit.click().catch(() => {});
      await page.waitForTimeout(3000);
    }
  } else if (hasEmailVerification) {
    // iCIMS sent a verification email — wait a bit and check Gmail for the link
    console.log('    [icims] email verification needed…');
    await handleGmailVerification(context, 'icims');
    await page.waitForTimeout(3000);
  } else if (hasCreateAccount || !alreadyCreated) {
    console.log('    [icims] creating new account…');
    await fillIcimsCreateForm(loginFrame2, cred);
    await handleGmailVerification(context, 'icims');
    await page.waitForTimeout(2000);
    markIcimsAccountCreated(persona);
  } else {
    // The email page is still showing (submit didn't work) — try navigating directly to login
    console.log('    [icims] email submit may have failed — trying direct password login');
    const loginUrl = page.url().replace(/[?].*/,"") + '/login?in_iframe=1';
    try {
      await page.goto(loginUrl.replace('/job?', '/login?'), {waitUntil:'domcontentloaded', timeout:15000});
      await page.waitForTimeout(2000);
    } catch(e) {}
  }

  return null; // null = proceed
}

async function fillIcimsCreateForm(frame, cred) {
  const fill = async (sel, val) => {
    const el = await frame.$(sel).catch(() => null);
    if (el && val && await el.isVisible().catch(() => false)) await el.fill(String(val)).catch(() => {});
  };

  const [firstName, ...restName] = cred.name.split(' ');
  const lastName = restName.join(' ') || cred.name;

  await fill('input[name*="firstName" i], input[id*="firstName" i]', firstName);
  await fill('input[name*="lastName" i], input[id*="lastName" i]', lastName);
  await fill('input[type="email"], input[name*="email" i], input[id*="email" i], input[name="css_loginName"]', cred.email);
  await fill('input[type="password"][name*="password" i]:not([name*="confirm" i]):not([name*="verify" i])', cred.password);
  await fill('input[type="password"][name*="confirm" i], input[type="password"][id*="confirm" i]', cred.password);

  await frame.waitForTimeout(400);

  const submitBtn = await frame.$('button[type="submit"], input[type="submit"], button:has-text("Create"), button:has-text("Register")').catch(() => null);
  if (submitBtn && await submitBtn.isVisible().catch(() => false)) {
    await submitBtn.click().catch(() => {});
    await frame.waitForTimeout(3000);
  }
}

// ── Application form fill ──────────────────────────────────────────────────

async function fillIcimsApplication(page, jobMeta) {
  console.log('    [icims] filling iCIMS application…');

  let stepCount = 0;
  const MAX_STEPS = 10;

  while (stepCount < MAX_STEPS) {
    stepCount++;
    await page.waitForTimeout(1000);

    // Always get the current frame state
    const frame = await getIcimsFrame(page);
    const pageText = await frame.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
    const stepTitle = await frame.evaluate(() => {
      const h = document.querySelector('h1, h2, .iCIMS_Header, [class*="section-title"], [class*="step-title"]');
      return h ? h.innerText.trim().slice(0, 100) : '';
    }).catch(() => '');

    console.log(`    [icims] step ${stepCount}: ${stepTitle || '(page)'}`, frame.url().slice(0, 80));

    // Check for completion
    if (/already applied|application received|application submitted|thank you for applying/i.test(pageText)) {
      return 'submitted';
    }

    // Resume upload step
    if (/upload.*resume|attach.*resume|resume.*upload/i.test(pageText) || /upload/i.test(stepTitle)) {
      trace.stage("icims:resume");
      const up = await attachResume(page, frame, a.resumePath);
      if (!up.ok) console.log('    [icims] resume upload issue:', up.result.reason);
    } else if (/contact|personal|profile|information/i.test(stepTitle)) {
      await fillIcimsContactStep(frame);
    } else if (/work.*experience|experience|employment/i.test(stepTitle)) {
      console.log('    [icims] work experience — relying on resume parse');
    } else if (/education/i.test(stepTitle)) {
      console.log('    [icims] education — relying on resume parse');
    } else if (/question|screening|additional/i.test(stepTitle)) {
      await fillIcimsQuestions(frame);
    } else if (/review|summary|preview/i.test(stepTitle)) {
      break;
    } else {
      await fillIcimsContactStep(frame);
      await fillIcimsQuestions(frame);
    }

    await fillRemainingRequired(frame).catch(() => {});
    await handleRadioGroups(frame).catch(() => {});

    // Look for Next / Continue / Save button
    let advanced = false;
    for (const sel of [
      'button:has-text("Next")', 'button:has-text("Continue")',
      'button:has-text("Save and Continue")', 'button:has-text("Save & Continue")',
      'input[type="submit"][value*="Next" i]', 'input[type="submit"][value*="Continue" i]',
      'input[type="submit"][value*="Save" i]',
      '[id*="next" i][type="button"]', '[id*="continue" i][type="button"]',
    ]) {
      const btn = await frame.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.click().catch(() => {});
        advanced = true;
        break;
      }
    }
    if (!advanced) break;
    await page.waitForTimeout(1500);
  }

  return 'filled';
}

async function fillIcimsContactStep(frame) {
  const fill = async (sel, val) => {
    const el = await frame.$(sel).catch(() => null);
    if (el && val && await el.isVisible().catch(() => false)) {
      const cur = await el.inputValue().catch(() => '');
      if (!cur) await el.fill(String(val)).catch(() => {});
    }
  };

  await fill('input[name*="firstName" i], input[id*="firstName" i]', a.firstName);
  await fill('input[name*="lastName" i], input[id*="lastName" i]', a.lastName);
  await fill('input[type="email"], input[name*="email" i], input[id*="email" i]', a.email);
  await fill('input[type="tel"], input[name*="phone" i], input[id*="phone" i]', a.phoneDigits);
  await fill('input[name*="address" i]:not([name*="email" i]):not([name*="line2" i])', a.addressLine1 || a.city);
  await fill('input[name*="city" i], input[id*="city" i]', a.city);
  await fill('input[name*="zip" i], input[name*="postal" i], input[id*="zip" i]', a.zip || '');
  await fill('input[name*="linkedin" i]', a.linkedIn);

  for (const sel of await frame.$$('select')) {
    const label = await sel.evaluate(e => (e.getAttribute('aria-label') || e.closest('div,label')?.innerText || '').slice(0, 100)).catch(() => '');
    if (!/state|province/i.test(label)) continue;
    const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim()));
    const pick = (a.stateFull && opts.find(o => new RegExp('^\\s*' + a.stateFull + '\\b', 'i').test(o))) || (a.state && opts.find(o => new RegExp('\\b' + a.state + '\\b').test(o)));
    if (pick) await sel.selectOption({ label: pick }).catch(() => {});
    break;
  }

  for (const sel of await frame.$$('select')) {
    const label = await sel.evaluate(e => (e.getAttribute('aria-label') || e.closest('div,label,fieldset')?.innerText || '').slice(0, 200)).catch(() => '');
    const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim())).catch(() => []);
    if (/authoriz.*work|work.*authoriz|eligible.*work/i.test(label)) {
      const yes = opts.find(o => /^yes\b/i.test(o));
      if (yes) await sel.selectOption({ label: yes }).catch(() => {});
    }
    if (/sponsor|visa.*sponsor/i.test(label)) {
      const no = opts.find(o => /^no\b/i.test(o));
      if (no) await sel.selectOption({ label: no }).catch(() => {});
    }
  }
}

async function fillIcimsQuestions(frame) {
  for (const el of await frame.$$('input[type="text"]:not([aria-hidden="true"]), textarea:not([aria-hidden="true"])')) {
    if (!(await el.isVisible().catch(() => false))) continue;
    const cur = await el.inputValue().catch(() => '');
    if (cur) continue;
    const label = await el.evaluate(e => {
      const lbl = document.querySelector(`label[for="${e.id}"]`);
      if (lbl) return lbl.innerText.trim().slice(0, 200);
      return (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.closest('div,fieldset')?.innerText || '').slice(0, 200);
    }).catch(() => '');
    if (!label) continue;

    if (/linkedin/i.test(label)) { await el.fill(a.linkedIn).catch(() => {}); continue; }
    if (/salary|compensation|desired pay/i.test(label)) { await el.fill(a.salaryRangeString || '').catch(() => {}); continue; }
    if (/years.*experience|experience.*years/i.test(label)) { await el.fill(String(a.totalYearsExperience)).catch(() => {}); continue; }

    if (/^(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\b/i.test(label)) {
      const yn = yesNoForLabel(label, a);
      if (yn) { await el.fill(yn).catch(() => {}); continue; }
    }
    const ans = generateAnswer(label, a);
    if (ans) await el.fill(ans.slice(0, 1000)).catch(() => {});
  }

  for (const sel of await frame.$$('select')) {
    const cur = await sel.evaluate(e => e.value).catch(() => '');
    if (cur && !/^$|select|choose/i.test(cur)) continue;
    const label = await sel.evaluate(e => (e.getAttribute('aria-label') || e.closest('div,fieldset,label')?.innerText || '').slice(0, 200)).catch(() => '');
    const opts = await sel.$$eval('option', os => os.map(o => o.textContent.trim())).catch(() => []);
    let pick = null;
    if (/authoriz.*work|work.*authoriz|eligible.*work/i.test(label)) pick = opts.find(o => /^yes\b/i.test(o));
    else if (/sponsor/i.test(label)) pick = opts.find(o => /^no\b/i.test(o));
    else if (/country/i.test(label)) pick = opts.find(o => /united states/i.test(o));
    else if (/state|province/i.test(label)) pick = a.stateFull ? opts.find(o => new RegExp('^\\s*' + a.stateFull + '\\b', 'i').test(o)) : null;
    // EEO from the persona (src/util/eeo.js), never a default demographic.
    else if (/gender/i.test(label)) pick = pickEeo('gender', opts, a);
    else if (/hispanic|latino/i.test(label)) pick = pickEeo('hispanic', opts, a);
    else if (/race|ethnicity/i.test(label)) pick = pickEeo('race', opts, a);
    else if (/veteran/i.test(label)) pick = pickEeo('veteran', opts, a);
    else if (/disab/i.test(label)) pick = pickEeo('disability', opts, a);
    else if (/highest.*degree|degree.*earned|education.*level/i.test(label)) pick = opts.find(o => /bachelor/i.test(o));
    if (pick) await sel.selectOption({ label: pick }).catch(() => {});
  }

  await handleRadioGroups(frame).catch(() => {});
}

// ── Main export ────────────────────────────────────────────────────────────

const trace = require("../util/trace");
async function applyIcims(page, jobMeta, answers, opts) {
  trace.stage("icims");
  const url = (typeof jobMeta === 'string' ? jobMeta : (jobMeta && jobMeta.url)) || page.url();
  const meta = typeof jobMeta === 'object' && jobMeta !== null ? jobMeta : { url };

  const persona = (answers && answers.persona) || a.persona;
  let cred;
  try { cred = getCredentials(persona); }
  catch (e) { return { status: 'Error', reason: e.message }; }

  console.log(`    [icims] url: ${url}`);

  // Skip non-US postings (check before iframe)
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '');
  if (/\bIndia\b|\bMumbai\b|\bBangalore\b|\bBengaluru\b|\bUK\b|\bUnited Kingdom\b|\bGermany\b|\bLondon\b/i.test(bodyText)) {
    return { status: 'Skipped', reason: 'Non-US iCIMS posting' };
  }

  // Log in or create account (works through iframe)
  let loginResult;
  try {
    loginResult = await ensureIcimsLoggedIn(page, cred, persona);
  } catch (e) {
    return { status: 'Error', reason: 'iCIMS login error: ' + e.message.slice(0, 200) };
  }

  if (loginResult && loginResult.status) return loginResult;

  // Pre-submit review gate
  trace.stage("icims:review");
  const reviewBlock = await gateBeforeSubmit(page, page, { persona: answers || a, jobMeta: meta }).catch(() => null);
  if (reviewBlock) return reviewBlock;

  // Fill the application
  let fillResult;
  try {
    fillResult = await fillIcimsApplication(page, meta);
  } catch (e) {
    return { status: 'Error', reason: 'iCIMS form fill error: ' + e.message.slice(0, 200) };
  }

  if (fillResult === 'submitted') return { status: 'Applied', reason: '—' };

  // DRY_RUN
  if (process.env.DRY_RUN) {
    const shot = require('../util/form').dryRunShotPath(`icims-${(meta && meta.company) || 'job'}`);
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    return { status: 'DryRun', reason: `iCIMS form filled — screenshot ${shot}` };
  }

  // Find and click Submit — look in the current iframe frame
  const submitFrame = await getIcimsFrame(page);
  let submitted = false;
  for (const sel of [
    'button:has-text("Submit")', 'button:has-text("Submit Application")',
    'input[type="submit"][value*="Submit" i]', '[id*="submitButton" i]',
    'input[type="submit"][value*="Apply" i]',
    'button:has-text("Apply")', 'input[type="submit"]',
  ]) {
    const btn = await submitFrame.$(sel).catch(() => null);
    if (btn && await btn.isVisible().catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(300);
      await btn.click({ timeout: 10000 }).catch(() => {});
      submitted = true;
      break;
    }
  }

  if (!submitted) {
    // Also try on main page as fallback
    for (const sel of ['button:has-text("Submit")', 'input[type="submit"]']) {
      const btn = await page.$(sel).catch(() => null);
      if (btn && await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        submitted = true;
        break;
      }
    }
  }

  if (!submitted) return { status: 'Error', reason: 'iCIMS submit button not found' };

  // Poll for confirmation
  const CONFIRM = /thank you|application (submitted|received|complete)|we.ve received|application.*success|successfully.*applied/i;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(2500);
    if (/confirmation|success|thank.?you|submitted/i.test(page.url())) return { status: 'Applied', reason: '—' };
    const txt = await page.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(txt)) return { status: 'Applied', reason: '—' };
    // Check iframe too
    const f = await getIcimsFrame(page);
    const ftxt = await f.evaluate(() => document.body.innerText.slice(0, 2500)).catch(() => '');
    if (CONFIRM.test(ftxt)) return { status: 'Applied', reason: '—' };
  }

  return { status: 'Error', reason: 'No iCIMS confirmation after submit' };
}

module.exports = { applyIcims };
