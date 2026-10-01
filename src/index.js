// Main runner — reads queue.json, dedupes against seen-jobs.csv, routes each URL to per-ATS handler.
const companyCap = require('./core/company-cap');
const trace = require("./util/trace");
const hygiene = require("./core/browser-hygiene");
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { applyLever } = require('./ats/lever');
const { applyAshby } = require('./ats/ashby');
const { applyGreenhouse } = require('./ats/greenhouse');
const { applyWorkable } = require('./ats/workable');
const { applyCareerpuck } = require('./ats/careerpuck');
const { applySmartrecruiters } = require('./ats/smartrecruiters');
const { applyWorkday } = require('./ats/workday');
const { applyIcims } = require('./ats/icims');
const { applyBamboohr } = require('./ats/bamboohr');
const { applyRippling } = require('./ats/rippling');
const { applyBreezy } = require('./ats/breezy');
const { applyJobvite } = require('./ats/jobvite');
const { resolveLinkedInApplyUrl } = require('./ats/linkedin-resolve');
const { appendApplication, appendSeen, loadSeenUrls } = require('./log');
const ledger = require('./core/ledger');
const rounds = require('./core/rounds');
const queues = require('./core/queues');
const autonomy = require('./core/autonomy');
const sources = require('./core/sources');
const answers = require('./answers'); // throws if PERSONA not set — intentional
const machine = require('./core/machine');
const locks = require('./core/locks');
const progress = require('./core/progress');
const stopflag = require('./core/stopflag');
const { detectExpired, partitionByFreshness } = require('./util/freshness');
const { verifyResumeFile } = require('./resume/verify');
const { resolveResume } = require('./resume/resolve');

// The persona's base resume, captured before any per-job resolution mutates it.
const BASE_RESUME_PATH = answers.resumePath;

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
// Resume tailoring is OPT-IN. Without --tailor (or TAILOR=1) the batch pass does not
// run at all: no model call, no tailored writes, no rendered PDFs — base resumes
// upload exactly as they did before this existed.
const TAILOR = process.argv.includes('--tailor') || /^(1|true|yes|on)$/i.test(process.env.TAILOR || '');

function atsHold(ats) {
  // Temporary per-ATS pause, set in data/ats-hold.json as
  // {"ashby": {"until": "<ISO time>", "reason": "..."}}. Held jobs are NOT marked seen,
  // so they get applied to once the hold lapses.
  try {
    const h = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'data', 'ats-hold.json'), 'utf8'))[ats];
    if (h && h.until && Date.now() < Date.parse(h.until)) return h;
  } catch { /* no hold file = no hold */ }
  return null;
}

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
  if (/bamboohr\.com/i.test(url)) return 'bamboohr';
  if (/ats\.rippling\.com/i.test(url)) return 'rippling';
  if (/breezy\.hr/i.test(url)) return 'breezy';
  if (/jobvite\.com/i.test(url)) return 'jobvite';
  return 'unknown';
}

async function main() {
  if (!fs.existsSync(QUEUE_FILE)) {
    console.error(`Queue file not found: ${QUEUE_FILE}`);
    console.error('Create one with: [{"url": "https://...", "company": "X", "role": "Y"}, ...]');
    process.exit(1);
  }
  // Resume preflight for the ACTIVE persona, before anything expensive.
  //
  // rounds.start() checks all three personas, but only when it actually starts a
  // round — a run-loop batch passes an existing ROUND_ID and skips it. This check
  // is unconditional, so no batch can reach a form without a verified resume.
  const rv = verifyResumeFile(answers.resumePath);
  if (!rv.ok) {
    console.error(`Resume unusable for persona ${answers.persona}: ${rv.detail}`);
    console.error('Refusing to run. An application submitted without its attachment is recorded as a success and cannot be undone.');
    process.exit(1);
  }

  const queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  const seen = loadSeenUrls();
  const auto = autonomy.status();
  const round = ROUND_ID
    ? (rounds.status(ROUND_ID) || rounds.start({ id: ROUND_ID, persona: answers.persona, target: SESSION_TARGET, maxEvaluated: MAX_EVALUATED, autonomyMode: auto.mode }))
    : rounds.start({ persona: answers.persona, target: SESSION_TARGET, maxEvaluated: MAX_EVALUATED, autonomyMode: auto.mode });

  // This process is about to open the browser, so it takes over the guards' pid
  // (see locks.adopt) and beats their heartbeat as it works. A batch child resuming
  // an outer ROUND_ID does not acquire anything — its parent already holds both —
  // but it is the process doing the long work, so it is the one that must beat.
  // Without that, a 40-minute batch would let the other machine declare the lock
  // stale and start a second run on the same profile.
  const GUARD = { roundId: round.id, profileKey: round.profileKey || answers.profileKey };
  rounds.adopt(GUARD);
  const beat = () => { try { rounds.heartbeat(GUARD); } catch { /* never fail a run over a heartbeat */ } };
  // Release on every abort path, not just the happy one. A crashed run that keeps
  // its lock costs the next scheduled run — a whole night on the server.
  let released = false;
  const releaseGuards = () => {
    if (released) return;
    released = true;
    // Only when this process owns the round. A batch child must not release the
    // guards its parent holds and will keep using for the next batch.
    if (ROUND_ID) return;
    try { rounds.release(GUARD); } catch { /* best effort */ }
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { releaseGuards(); process.exit(130); });
  }
  process.on('exit', releaseGuards);

  console.log(`Persona: ${answers.persona} (${answers.fullName} <${answers.email}>)`);
  console.log(`Profile: ${PROFILE_DIR}`);
  console.log(`Machine: ${machine.id()}`);
  console.log(`Loaded ${queue.length} jobs from queue, ${seen.size} already seen.`);

  // Freshness of the queue itself, reported before the run rather than discovered as a
  // string of "expired" skips. A queue is built once and consumed over days, so its age
  // is the best predictor of how much of the session will be wasted — and 71% of rows
  // historically arrive with no posting date at all, which the recency filter cannot see.
  const freshness = partitionByFreshness(queue);
  console.log(`Queue:  ${freshness.fresh.length} fresh, ${freshness.stale.length} older than ${freshness.maxDays}d`
    + `, ${freshness.undated} with no posting date`
    + (freshness.stale.length ? ' — stale rows run last' : ''));
  // Stale rows are not dropped: an old posting may still be open, and the page check
  // settles it in one navigation. They go to the BACK of the queue so a limited session
  // spends its budget on the freshest jobs first.
  if (freshness.stale.length) queue.length = 0, queue.push(...freshness.fresh, ...freshness.stale);
  console.log(`Round:   ${round.id}  (autonomy: ${auto.mode}${auto.granted ? `, granted until ${auto.expiresAt}` : ''})`);
  console.log(`Target: ${SESSION_TARGET} submissions, max evaluated: ${MAX_EVALUATED}`);
  console.log(`Tailor: ${TAILOR ? 'ON (batch pass before applying)' : 'off — uploading base resumes'}`);

  // Disk and profile count in the run header, so growth is visible while it is still
  // just a number. This repo once reached 23 profile directories and 5 GB, and the way
  // that happens is nobody looking until a run fails.
  try {
    const disk = require('./util/disk');
    const prof = require('./core/profiles').list();
    const runs = require('./core/retention').runArtifactUsage();
    const freeGb = disk.round1(disk.freeGb(require('./core/paths').root));
    const floor = require('./core/config')().diskFreeFloorGb;
    console.log(`Disk:   ${freeGb} GB free (floor ${floor} GB) | profiles: ${prof.totals.knownCount} live`
      + `${prof.totals.unknownCount ? `, ${prof.totals.unknownCount} ORPHAN — \`npm run agent -- profiles prune\`` : ''}`
      + ` (${prof.totals.liveMb} MB) | run artifacts: ${runs.totalMb} MB`);
    const sch = require('./core/schema').status();
    console.log(`Schema: code v${sch.codeVersion}, state ${sch.stateVersion === null ? 'unstamped' : 'v' + sch.stateVersion}${sch.match ? '' : ' — MISMATCH'}`);
  } catch (e) {
    console.log(`Disk:   (could not measure: ${e.message})`);
  }
  console.log('');

  // ── Tailoring batch pass: after discovery, BEFORE the browser opens ───────
  //
  // Deliberately here and not inside the job loop. A model call between opening a form
  // and submitting it means every application waits on inference, and an outage
  // mid-run strands a browser on a half-filled form. Out here an outage costs nothing:
  // every row falls back to base and the run continues.
  //
  // DRY_RUN still runs the pass, on purpose — the point of a dry run is to inspect what
  // would be sent, and tailored resumes are the part most worth reading before any live
  // submission.
  if (TAILOR) {
    const { tailorQueue } = require('./resume/tailor');
    const pending = queue.filter((j) => j.url && !seen.has((j.url || '').split('?')[0].split('#')[0]));
    console.log(`--- tailoring pass: ${pending.length} job(s) ---`);
    try {
      const rep = await tailorQueue({
        jobs: pending,
        persona: answers,
        roundId: round.id,
        onProgress: ({ n, of, company, role }) => console.log(`    [${n}/${of}] ${company || '?'} — ${role || ''}`),
      });
      console.log(`--- tailoring done: ${rep.accepted} accepted, ${rep.rejected} rejected, ${rep.fallback} fallback`
        + ` (backend: ${rep.backend}, base text: ${rep.baseTextSource || 'n/a'}) ---`);
      for (const [reason, count] of Object.entries(rep.reasons)) console.log(`      ${count}x ${reason}`);
    } catch (e) {
      // Tailoring must never take a run down with it.
      console.error(`--- tailoring pass failed (continuing with base resumes): ${e.message} ---`);
      queues.frictionRecord({
        area: 'resume:tailor', reproducible: false,
        summary: 'tailoring pass threw', signature: (e.message || '').slice(0, 120),
      });
    }
    console.log('');
  }

  // Sweep stale bot-scoring cookies BEFORE Chrome takes its lock on the database.
  // Once the context is open the file is locked and a sweep silently does nothing.
  try { hygiene.sweepIfDue(PROFILE_DIR, { persona: answers.persona }); } catch (e) { /* never block a run */ }

  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome', // reuse the real-Chrome profile created during login
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  let applied = 0;
  let evaluated = 0;
  let stopped = null;
  let skipped = 0;
  let errored = 0;
  // Dry-run rehearsals: filled and screenshotted, never submitted. In a dry run they
  // are what SESSION_TARGET counts, so `--dry-run --max 3` stops after three.
  let rehearsed = 0;
  const IS_DRY = !!process.env.DRY_RUN;

  // Pacing: put real time between applications.
  //
  // The loop ran flat out - one 800ms wait after navigation and nothing else - so
  // twenty applications landed within a couple of minutes from one browser profile
  // and one IP. That cadence is what Ashby scores as possible spam (64 rejections in
  // a single round) and what earns a DataDome block on SmartRecruiters. Throughput
  // was never the constraint here; acceptance is. Tunable for a deliberate fast run.
  const GAP_MS = Number(process.env.APPLY_GAP_MS || 25000);
  const JITTER_MS = Number(process.env.APPLY_JITTER_MS || 35000);
  const BREATHER_EVERY = Number(process.env.APPLY_BREATHER_EVERY || 8);
  const BREATHER_MS = Number(process.env.APPLY_BREATHER_MS || 90000);
  let paced = 0;

  for (const job of queue) {
    if (applied + (IS_DRY ? rehearsed : 0) >= SESSION_TARGET) {
      console.log(`\nHit SESSION_TARGET=${SESSION_TARGET}${IS_DRY ? ' (dry-run rehearsals)' : ''}. Stopping.`);
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

      // One application budget per company, shared across every persona. Dedupe above is
      // per-URL, so without this every new posting at a company looks fresh forever — which
      // is how the ledger reached 103 applications to one employer. See core/company-cap.js.
      const capReason = companyCap.blockedReason(job.company, process.cwd(), job.role);
      if (capReason) {
        console.log(`[skip cap] ${job.company} - ${job.role}: ${capReason}`);
        continue;
      }

    // ── Graceful stop, checked BETWEEN jobs ───────────────────────────────
    //
    // Between, never during: a stop that landed between filling a form and clicking
    // submit would leave the employer with nothing and the ledger with no row either
    // way. The job in flight always finishes.
    const stopReq = stopflag.read(round.id);
    if (stopReq) {
      console.log(`\n⏹ stop requested by ${stopReq.requestedBy}${stopReq.reason ? ` (${stopReq.reason})` : ''} — finishing here.`);
      stopped = stopReq;
      break;
    }

    evaluated++;
    // Per job: the cheapest place to prove this run is still alive.
    beat();
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
    const hold = atsHold(ats);
    if (hold) {
      console.log(`    [skip hold] ${ats} paused until ${hold.until} - left in the queue for later`);
      evaluated--;
      continue;
    }

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
      if (ats === 'taleo') {
        console.log(`    SKIPPING - taleo requires account creation (no handler yet).`);
        queues.attentionAdd({
          kind: 'account-creation', url, company: job.company, role: job.role,
          persona: answers.persona, roundId: round.id,
          summary: 'taleo requires an account and a password',
          nextAction: 'Create the account yourself, then re-queue this URL.',
        });
        appendSeen({ company: job.company, role: job.role, url, action: 'Skipped', reason: 'taleo requires account/password' });
        seen.add(url);
        skipped++;
        continue;
      }
      // workday and icims now have handlers — fall through to the dispatch map below.
    }
    if (ats === 'unknown') {
      console.log(`    SKIPPING - unknown ATS, no handler.`);
      queues.frictionRecord({ area: 'ats:unknown', url, reproducible: true, summary: 'no handler for this ATS host', signature: 'unknown-ats:' + (url.split('/')[2] || '') });
      appendSeen({ company: job.company, role: job.role, url, action: 'Skipped', reason: 'Unknown ATS - no handler' });
      seen.add(url);
      skipped++;
      continue;
    }

    // ── Which resume does THIS job upload? ────────────────────────────────
    //
    // One resolver, one place. Handlers keep reading `a.resumePath`; pointing that at
    // the resolved file here is what makes the tailored variant work across all six
    // without touching any of them. The base path is restored afterwards so one job's
    // tailored file can never leak into the next.
    const resolved = resolveResume({ persona: answers, url, roundId: round.id, title: job.role || '' });
    answers.resumePath = resolved.path;
    if (resolved.variant !== 'base') {
      console.log(`    resume: tailored ${resolved.variant} (${path.basename(resolved.path)})`);
    } else if (resolved.baseVariant && resolved.baseVariant !== 'base') {
      console.log(`    resume: base/${resolved.baseVariant} (${path.basename(resolved.path)})`);
    } else if (TAILOR) {
      console.log(`    resume: base — ${resolved.reason}`);
    } else if (answers.resumeVariants && answers.resumeVariants.length) {
      // No title rule matched: say so, otherwise the fallback pick is invisible in the log.
      console.log(`    resume: base/fallback (${path.basename(resolved.path)})`);
    }

    // Wait here, not at the top of the loop: a skipped duplicate costs nothing and
    // should not be paced. Only a job we are about to actually open counts.
    if (paced) {
      const jitter = Math.floor(Math.random() * Math.max(1, JITTER_MS));
      const breather = BREATHER_EVERY > 0 && paced % BREATHER_EVERY === 0;
      const waitMs = GAP_MS + jitter + (breather ? BREATHER_MS : 0);
      console.log(`    pacing: waiting ${Math.round(waitMs / 1000)}s before this one${breather ? ` (longer breather)` : ``}`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
    paced++;

    // One trace row per stage, so a failure says WHICH step broke and how long it
    // took. Read it with: node src/trace-report.js
    trace.startJob({ round: round.id, persona: answers.persona, company: job.company, role: job.role, url, ats });

    let result;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(800);

      // ── Is the posting still open? ──────────────────────────────────────
      //
      // Checked HERE, once, rather than in each of six handlers: this is the only place
      // every ATS passes through after navigation. An expired posting used to be filled
      // in, fail to submit, and get recorded as a generic error — which spent the work,
      // charged it to the error budget, and made it eligible for retry. Of the last 500
      // evaluated rows, zero were recorded as expired, so this was invisible.
      const fresh = await detectExpired(page);
      if (fresh.expired) {
        trace.endJob({ status: "Expired", reason: fresh.evidence });
        console.log(`    Expired - ${fresh.evidence}`);
        appendSeen({ company: job.company, role: job.role, url, action: 'Expired', reason: `Posting expired/removed: ${fresh.evidence}` });
        seen.add(url);
        skipped++;
        try {
          progress.recordJob(round.id, { status: 'Skipped', company: job.company, role: job.role, reason: 'posting expired' });
        } catch { /* observability only */ }
        answers.resumePath = BASE_RESUME_PATH;
        continue;
      }
      trace.stage("apply", { ats });
      const handler = { greenhouse: applyGreenhouse, lever: applyLever, ashby: applyAshby, workable: applyWorkable, careerpuck: applyCareerpuck, smartrecruiters: applySmartrecruiters, workday: applyWorkday, icims: applyIcims, bamboohr: applyBamboohr, rippling: applyRippling, breezy: applyBreezy, jobvite: applyJobvite }[ats];
      // Per-job timeout: a single bad page (e.g. a custom-domain embed that hangs)
      // must never freeze the whole run. Cap each application at 150s.
      result = await Promise.race([
        handler(page, job),
        new Promise((_, reject) => { const ms = ats === 'greenhouse' ? 180000 : 90000; setTimeout(() => reject(new Error('job timeout (' + (ms/1000) + 's)')), ms); }),
      ]);
    } catch (err) {
      const msg = err.message || String(err);
      result = { status: 'Error', reason: 'Exception: ' + msg.slice(0, 200) };
      answers.resumePath = BASE_RESUME_PATH;
      // If the BROWSER/context itself died, abort the whole batch immediately —
      // do NOT mark this or remaining jobs as seen (that silently burns the queue
      // with bogus errors). A fresh batch with a new browser will retry them.
      if (/browser has been closed|context or browser has been closed|Target (page|browser|crashed)|page has been closed|Browser closed|crash/i.test(msg)) {
        console.error('    ⚠ Browser/context died — ABORTING batch (job NOT marked seen).');
        break;
      }
    }

    // Restore the base path before the next job resolves its own.
    answers.resumePath = BASE_RESUME_PATH;

    seen.add(url);
    console.log(`    ${result.status} - ${result.reason}`);

    // Progress into the round record, per job. This is what makes
    // `apply-agent round status --round <id>` answerable mid-run from another process —
    // and it is the only place skipped/errored/evaluated are persisted at all, since
    // seen-jobs.csv carries no round id.
    try {
      progress.recordJob(round.id, {
        status: result.status, company: job.company, role: job.role, reason: result.reason,
      });
    } catch { /* progress is observability; never fail a run over it */ }

    // AN ERROR IS NOT A TERMINAL OUTCOME (2026-09-14). This line used to run for
    // every result, Error included - and because loadSeenUrls harvests every URL
    // in this file regardless of action, a job that failed on OUR bug was burned
    // forever: skipped as [skip dup] on every later run, even after the bug was
    // fixed. That is precisely what happened today - a Greenhouse code-ordering
    // bug failed hundreds of jobs, wrote them all here, and then the fix could not
    // reach any of them. Errors stay retryable; friction.ndjson already records
    // them, so nothing is lost by not writing the row.
    // A bot-block is not an outcome for this job - it is a fact about the moment.
    // Writing it to the seen store burned the posting permanently, which is exactly
    // what returning Skipped instead of Error was meant to avoid. Let these come back.
    trace.endJob(result);

    const transientBlock = result.status === `Skipped`
      && /datadome|anti-bot|captcha|rate.?limit|too many requests|blocked by/i.test(result.reason || ``);
    // A dry-run rehearsal is not an outcome either: marking it seen would make the
    // practice run burn the job, and the real run after it would skip it as a duplicate.
    if (result.status !== `Error` && result.status !== `DryRun` && !transientBlock) {
      appendSeen({ company: job.company, role: job.role, url, action: result.status, reason: result.reason });
    }
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
          // Which file this employer actually received: the tailored hash, or 'base'.
          resumeVariant: resolved.variant,
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
      companyCap.record(job.company, job.role);
      console.log(`    ✅ Applied (${applied}/${SESSION_TARGET})`);
    } else if (result.status === 'Skipped') {
      skipped++;
      // A handler can attach an attention item to a skip — currently an emailed
      // verification code that neither the browser nor the orchestrator could supply.
      // Filed here because this is the one place with the url, company, persona and
      // round to file it against. The job stays actionable instead of being lost to a
      // line in seen-jobs.csv.
      if (result.attention) {
        try {
          queues.attentionAdd({
            ...result.attention,
            url, company: job.company, role: job.role,
            persona: answers.persona, roundId: round.id,
          });
          console.log('    ⚠ attention item raised — `npm run agent -- attention list`');
        } catch (e) {
          console.error('    ⚠ attention write failed:', e.message);
        }
      }
    } else if (result.status === 'DryRun') {
      rehearsed++;
      console.log(`    📝 Dry run (${rehearsed}/${SESSION_TARGET}) — filled, not submitted`);
    } else {
      errored++;
      queues.frictionRecord({
        area: 'ats:' + ats, url, reproducible: false,
        summary: 'application failed', signature: (result.reason || '').slice(0, 120),
      });
      // A broken resume FILE is not per-job friction — it will fail identically on
      // every remaining job. Park it for a human and stop, rather than burning the
      // queue to record the same error forty times.
      if (result.fatalFile) {
        console.error('    ⚠ Resume file is unusable — ABORTING run.');
        try {
          queues.attentionAdd({
            kind: 'other', severity: 'blocking', url,
            company: job.company, role: job.role,
            persona: answers.persona, roundId: round.id,
            summary: (result.reason || 'resume file unusable').slice(0, 300),
            nextAction: `Fix the resume file for persona ${answers.persona}, then re-run. Check the exact filename case.`,
          });
        } catch (e) {
          console.error('    ⚠ attention write failed:', e.message);
        }
        break;
      }
    }
  }

  console.log(`\n=== Session complete ===`);
  console.log(`Evaluated: ${evaluated}`);
  console.log(`Applied:   ${applied}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Errored:   ${errored}`);

  const open = queues.attentionList().filter((a) => a.roundId === round.id);
  if (open.length) console.log(`Attention: ${open.length} item(s) need you — \`npm run agent -- attention list\``);
  if (stopped) console.log(`Stopped early at the request of ${stopped.requestedBy}.`);

  // A batch runner owns the round; a standalone run closes its own. rounds.complete
  // releases both guards; the exit handler is the backstop for every other path.
  //
  // A stopped run completes the round HONESTLY — marked stopped, with the counts it
  // reached — rather than leaving it open. An open round holds its lock until the
  // staleness threshold expires, which would cost the next scheduled run.
  if (!ROUND_ID) {
    rounds.complete({
      id: round.id,
      note: stopped ? `stopped after ${evaluated} evaluated` : undefined,
      stopped: stopped ? { reason: stopped.reason || 'requested', requestedBy: stopped.requestedBy, force: !!stopped.force } : undefined,
    });
  }
  released = true;
  const due = ledger.review().due;
  if (due.hygieneReview) console.log('Review due: submission hygiene — `npm run review`');
  if (due.outcomeReview) console.log('Review due: outcome effectiveness — `npm run review`');

  await ctx.close();
}

main().catch(err => {
  // A guard refusal is not a crash either, and which guard refused decides what the
  // caller should do next.
  if (err instanceof locks.GuardRefusedError) {
    console.error(`Refusing to run — ${err.guard === locks.SEMAPHORE ? 'this host is busy' : 'the browser profile is locked'}:`);
    console.error(`  ${err.message}`);
    console.error(err.guard === locks.SEMAPHORE
      ? '  -> Wait for that run to finish, or run on the other machine.'
      : '  -> Wait for the holder to finish, or run a persona on a different profile (qa has its own).');
    console.error('  Inspect: npm run agent -- round locks');
    console.error('  If that run is definitely dead: npm run agent -- round unlock --force --persona <p>');
    process.exit(1);
  }
  // A preflight refusal is an expected outcome on an unprepared machine, not a
  // crash. Print the remedy rather than a stack trace — the whole point of checking
  // up front is that the operator learns what to do without reading source.
  if (err && err.name === 'PreflightError' && Array.isArray(err.failures)) {
    console.error(`Refusing to run — this machine is not ready (${err.failures.length} blocking):`);
    for (const f of err.failures) {
      console.error(`  ${f.name}: ${f.detail}`);
      if (f.remedy) console.error(`    -> ${f.remedy}`);
    }
    console.error('\nFull report: npm run doctor');
    process.exit(1);
  }
  console.error('Fatal error:', err);
  process.exit(1);
});
