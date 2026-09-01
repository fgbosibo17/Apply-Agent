// Main runner — reads queue.json, dedupes against seen-jobs.csv, routes each URL to per-ATS handler.
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { applyLever } = require('./ats/lever');
const { applyAshby } = require('./ats/ashby');
const { applyGreenhouse } = require('./ats/greenhouse');
const { applyWorkable } = require('./ats/workable');
const { applyCareerpuck } = require('./ats/careerpuck');
const { applySmartrecruiters } = require('./ats/smartrecruiters');
const { resolveLinkedInApplyUrl } = require('./ats/linkedin-resolve');
const { appendApplication, appendSeen, loadSeenUrls } = require('./log');
const ledger = require('./core/ledger');
const rounds = require('./core/rounds');
const queues = require('./core/queues');
const autonomy = require('./core/autonomy');
const sources = require('./core/sources');
const answers = require('./answers'); // throws if PERSONA not set — intentional

// Each persona carries its own browser profile (and identity). No default.
// BROWSER_PROFILE env overrides it (used to switch to a fresh profile if the
// persona's profile gets corrupted — cloud ATS applies need no login anyway).
const PROFILE_DIR = process.env.BROWSER_PROFILE
  ? path.resolve(__dirname, '..', process.env.BROWSER_PROFILE)
  : answers.browserProfile;
// Per-persona queue; fall back to legacy queue.json if the persona file is absent.
const PERSONA_QUEUE = path.resolve(__dirname, '..', `queue-${answers.persona}.json`);
const QUEUE_FILE = fs.existsSync(PERSONA_QUEUE) ? PERSONA_QUEUE : path.resolve(__dirname, '..', 'queue.json');

const SESSION_TARGET = parseInt(process.env.SESSION_TARGET || '40', 10);
const MAX_EVALUATED = parseInt(process.env.MAX_EVALUATED || '200', 10);
// ROUND_ID lets run-loop.js stitch its fresh-browser batches into one round.
const ROUND_ID = process.env.ROUND_ID || '';

function detectAts(url) {
  if (/careerpuck\.com/i.test(url)) return 'careerpuck';
  if (/boards\.greenhouse\.io|job-boards\.greenhouse\.io|greenhouse\.io\/embed/i.test(url)) return 'greenhouse';
  if (/jobs\.lever\.co/i.test(url)) return 'lever';
  if (/jobs\.ashbyhq\.com/i.test(url)) return 'ashby';
  if (/apply\.workable\.com|workable\.com/i.test(url)) return 'workable';
  if (/smartrecruiters\.com/i.test(url)) return 'smartrecruiters';
  if (/myworkdayjobs\.com/i.test(url)) return 'workday';
  if (/icims\.com/i.test(url)) return 'icims';
  if (/taleo\.net/i.test(url)) return 'taleo';
  return 'unknown';
}

async function main() {
  if (!fs.existsSync(QUEUE_FILE)) {
    console.error(`Queue file not found: ${QUEUE_FILE}`);
    console.error('Create one with: [{"url": "https://...", "company": "X", "role": "Y"}, ...]');
    process.exit(1);
  }
  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const seen = loadSeenUrls();
  const auto = autonomy.status();
  const round = ROUND_ID
    ? (rounds.status(ROUND_ID) || rounds.start({ id: ROUND_ID, persona: answers.persona, target: SESSION_TARGET, maxEvaluated: MAX_EVALUATED, autonomyMode: auto.mode }))
    : rounds.start({ persona: answers.persona, target: SESSION_TARGET, maxEvaluated: MAX_EVALUATED, autonomyMode: auto.mode });
  console.log(`Persona: ${answers.persona} (${answers.fullName} <${answers.email}>)`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Loaded ${queue.length} jobs from queue, ${seen.size} already seen.`);
  console.log(`Round:   ${round.id}  (autonomy: ${auto.mode}${auto.granted ? `, granted until ${auto.expiresAt}` : ''})`);
  console.log(`Target: ${SESSION_TARGET} submissions, max evaluated: ${MAX_EVALUATED}\n`);

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome', // reuse the real-Chrome profile created during login
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let applied = 0;
  let evaluated = 0;
  let skipped = 0;
  let errored = 0;

  for (const job of queue) {
    if (applied >= SESSION_TARGET) {
      console.log(`\nHit SESSION_TARGET=${SESSION_TARGET}. Stopping.`);
      break;
    }
    if (evaluated >= MAX_EVALUATED) {
      console.log(`\nHit MAX_EVALUATED=${MAX_EVALUATED}. Stopping.`);
      break;
    }

    let url = (job.url || '').split('?')[0].split('#')[0];
    if (!url) continue;
    if (seen.has(url)) {
      console.log(`[skip dup] ${job.company} - ${job.role}`);
      continue;
    }

    evaluated++;
    console.log(`\n[${evaluated}] ${job.company} - ${job.role}`);

    // LinkedIn-sourced listings: resolve the external company-ATS URL first.
    if (job.source === 'linkedin') {
      console.log(`    LinkedIn: ${url} — resolving external apply link...`);
      const r = await resolveLinkedInApplyUrl(ctx, page, job).catch(e => ({ error: e.message }));
      seen.add(url); // mark the LinkedIn view URL seen regardless
      if (r.easyApply) {
        // EXTERNAL-ATS-ONLY mode: never automate LinkedIn Easy Apply (anti-automation
        // + account-ban risk). Skip and rely on external-ATS apply paths instead.
        console.log('    Skipped - Easy Apply only (external-ATS-only mode)');
        appendSeen({ company: job.company, role: job.role, url, action: 'Skipped', reason: 'Easy Apply only - external-ATS-only mode' });
        skipped++; continue;
      }
      if (r.closed) {
        console.log('    Closed - no longer accepting');
        appendSeen({ company: job.company, role: job.role, url, action: 'Closed', reason: 'No longer accepting applications' });
        skipped++; continue;
      }
      if (!r.externalUrl) {
        console.log(`    Error - could not resolve external link (${r.error || 'unknown'})`);
        appendSeen({ company: job.company, role: job.role, url, action: 'Error', reason: 'LinkedIn external link unresolved: ' + (r.error || '') });
        errored++; continue;
      }
      url = r.externalUrl.split('?')[0].split('#')[0];
      console.log(`    → external: ${url}`);
      if (seen.has(url)) {
        console.log('    [skip dup] external URL already seen');
        continue;
      }
    }

    const ats = detectAts(url);
    console.log(`    URL: ${url}`);
    console.log(`    ATS: ${ats}`);

    // Ledger gate: catches the duplicates an exact-URL seen-set misses (same
    // requisition on another host, re-slugged title) and holds back a
    // same-company reapply that is still inside its cooldown.
    const gate = ledger.check({ url, company: job.company, role: job.role });
    if (gate.decision === 'stop') {
      console.log(`    SKIPPING - ${gate.reasons.join('; ')}`);
      appendSeen({ company: job.company, role: job.role, url, action: 'Duplicate', reason: gate.reasons.join('; ') });
      seen.add(url); skipped++; continue;
    }
    if (gate.decision === 'ask') {
      // Not a refusal — a decision the candidate owns. Park it and keep moving.
      console.log(`    NEEDS YOU - ${gate.reasons.join('; ')}`);
      queues.attentionAdd({
        kind: 'duplicate-decision', url, company: job.company, role: job.role,
        persona: answers.persona, roundId: round.id,
        summary: gate.reasons.join('; '),
        nextAction: 'Confirm this is a distinct requisition, then re-queue with an override.',
      });
      appendSeen({ company: job.company, role: job.role, url, action: 'Skipped', reason: 'Attention queue: ' + gate.reasons.join('; ') });
      seen.add(url); skipped++; continue;
    }

    if (ats === 'workday' || ats === 'icims' || ats === 'taleo') {
      console.log(`    SKIPPING - ${ats} requires account creation + password (manual).`);
      queues.attentionAdd({
        kind: 'account-creation', url, company: job.company, role: job.role,
        persona: answers.persona, roundId: round.id,
        summary: `${ats} requires an account and a password`,
        nextAction: 'Create the account yourself, then re-queue this URL.',
      });
      appendSeen({ company: job.company, role: job.role, url, action: 'Skipped', reason: `${ats} requires account/password` });
      seen.add(url);
      skipped++;
      continue;
    }
    if (ats === 'unknown') {
      console.log(`    SKIPPING - unknown ATS, no handler.`);
      queues.frictionRecord({ area: 'ats:unknown', url, reproducible: true, summary: 'no handler for this ATS host', signature: 'unknown-ats:' + (url.split('/')[2] || '') });
      appendSeen({ company: job.company, role: job.role, url, action: 'Skipped', reason: 'Unknown ATS - no handler' });
      seen.add(url);
      skipped++;
      continue;
    }

    let result;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(800);
      const handler = { greenhouse: applyGreenhouse, lever: applyLever, ashby: applyAshby, workable: applyWorkable, careerpuck: applyCareerpuck, smartrecruiters: applySmartrecruiters }[ats];
      // Per-job timeout: a single bad page (e.g. a custom-domain embed that hangs)
      // must never freeze the whole run. Cap each application at 150s.
      result = await Promise.race([
        handler(page, job),
        new Promise((_, reject) => setTimeout(() => reject(new Error('job timeout (150s)')), 150000)),
      ]);
    } catch (err) {
      const msg = err.message || String(err);
      result = { status: 'Error', reason: 'Exception: ' + msg.slice(0, 200) };
      // If the BROWSER/context itself died, abort the whole batch immediately —
      // do NOT mark this or remaining jobs as seen (that silently burns the queue
      // with bogus errors). A fresh batch with a new browser will retry them.
      if (/browser has been closed|context or browser has been closed|Target (page|browser|crashed)|page has been closed|Browser closed|crash/i.test(msg)) {
        console.error('    ⚠ Browser/context died — ABORTING batch (job NOT marked seen).');
        break;
      }
    }

    seen.add(url);
    console.log(`    ${result.status} - ${result.reason}`);

    appendSeen({ company: job.company, role: job.role, url, action: result.status, reason: result.reason });
    if (result.status === 'Applied') {
      applied++;
      // Append-only ledger row. `result.reason` is the visible confirmation the
      // handler saw — without it this is not recorded as a submission.
      try {
        ledger.add({
          company: job.company, role: job.role, url,
          persona: answers.persona,
          applicationChannel: ats,
          discoverySource: job.source || 'queue',
          discoverySourceId: job.sourceId || sources.resolveId(job.source),
          roundId: round.id,
          score: typeof job.score === 'number' ? job.score : null,
          gate: job.gate || 'review',
          autoEligible: job.autoEligible === true,
          confirmation: result.reason || 'submitted',
          notes: job.notes || '',
        });
      } catch (e) {
        console.error('    ⚠ ledger write failed:', e.message);
      }
      appendApplication({
        company: job.company,
        role: job.role,
        url,
        atsPlatform: ats,
        discoverySource: job.source || 'queue',
        status: 'Applied',
        matchScore: job.matchScore || '',
        notes: job.notes || '',
        persona: answers.persona,
      });
      console.log(`    ✅ Applied (${applied}/${SESSION_TARGET})`);
    } else if (result.status === 'Skipped') {
      skipped++;
    } else {
      errored++;
      queues.frictionRecord({
        area: 'ats:' + ats, url, reproducible: false,
        summary: 'application failed', signature: (result.reason || '').slice(0, 120),
      });
    }
  }

  console.log(`\n=== Session complete ===`);
  console.log(`Evaluated: ${evaluated}`);
  console.log(`Applied:   ${applied}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Errored:   ${errored}`);

  const open = queues.attentionList().filter((a) => a.roundId === round.id);
  if (open.length) console.log(`Attention: ${open.length} item(s) need you — \`npm run agent -- attention list\``);
  // A batch runner owns the round; a standalone run closes its own.
  if (!ROUND_ID) rounds.complete({ id: round.id });
  const due = ledger.review().due;
  if (due.hygieneReview) console.log('Review due: submission hygiene — `npm run review`');
  if (due.outcomeReview) console.log('Review due: outcome effectiveness — `npm run review`');

  await ctx.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
