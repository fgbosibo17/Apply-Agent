// SE/TAM cloud goal orchestrator (2026-07-07).
//
// Goal (user): "using my cloud resume persona apply to Sales Engineer roles and
// Technical Account Manager roles — at least 100 of each, expand as you go.
// Remote first, then hybrid in Texas."
//
// Strategy — three phases, each a discover -> clean -> drain-apply loop:
//   Phase 1  FOCUS/REMOTE : Sales Engineer + TAM (+ solutions/presales/forward-
//                           deployed family), REMOTE-US only, until BOTH
//                           SE >= SE_TARGET and TAM >= TAM_TARGET (or supply dry).
//   Phase 2  EXPAND/REMOTE: broaden to the full cloud SE/solutions/CS keyword
//                           family (no TITLE_FILTER), still REMOTE-US only.
//   Phase 3  HYBRID-TX     : allow hybrid-in-Texas too (REMOTE_ONLY off), focus
//                           back on the SE/TAM family, to squeeze extra supply.
//
// SE and TAM applied counts are read from applications-log.csv (cloud persona,
// all-time). Apply is delegated to run-loop.js (watchdog + profile rotation).
//
//   PERSONA=cloud node src/se-tam-run.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PERSONA = 'cloud';
const SE_TARGET = parseInt(process.env.SE_TARGET || '100', 10);
const TAM_TARGET = parseInt(process.env.TAM_TARGET || '100', 10);
const MAX_CYCLES = parseInt(process.env.MAX_CYCLES || '40', 10);
// One profile per persona (src/personas.js). This used to default to
// 'browser-profile-setam', a name no persona owned.
const APPLY_PROFILE = process.env.APPLY_PROFILE || `browser-profile-${PERSONA}`;

// Submittable ATSs first (greenhouse/ashby/workable reliably pass forms); lever/
// smartrecruiters are captcha-walled — only swept in later phases to squeeze
// residual supply.
const ATS_SUBMITTABLE = 'greenhouse,ashby,workable';
const ATS_ALL = 'greenhouse,ashby,workable,lever,smartrecruiters';
const DISC_MAX = process.env.DISC_MAX || '800';

// Focused title family for phases 1 & 3 (SE + TAM + adjacent). Deliberately
// excludes bare "field engineer"/"deployment engineer" to avoid hardware noise.
const FOCUS_TITLE = 'sales engineer|sales engineering|pre[- ]?sales|presales|technical account manager|\\bTAM\\b|solutions engineer|solutions consultant|solutions architect|forward[- ]?deployed';

// Counting regexes (whole-line match against a cloud+Applied log row).
// TAM broadened (2026-07-07) to the genuine TAM technical-account family after
// strict-TAM supply capped at 44 in-scope — these are the same job function a
// TAM candidate applies to, remote-appropriate, and on the cloud persona's target
// set. Deliberately excludes generic (non-technical) "Customer Success Manager".
const SE_RE = /sales engineer|sales engineering|pre-?sales engineer/i;
const TAM_RE = /technical account manager|\bTAM\b|technical customer success|technical account executive|customer success engineer|technical engagement manager|technical relationship manager|technical success manager|technical account specialist|technical customer success manager/i;

function counts() {
  let se = 0, tam = 0, total = 0;
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'applications-log.csv'), 'utf8').split(/\r?\n/).slice(1);
    for (const x of lines) {
      if (!x.trim() || !/,Applied,/i.test(x) || !/cloud\s*$/i.test(x)) continue;
      total++;
      if (SE_RE.test(x)) se++;
      if (TAM_RE.test(x)) tam++;
    }
  } catch {}
  return { se, tam, total };
}

function step(label, args, env, timeoutMs) {
  console.log(`\n[${new Date().toISOString()}] ${label}: node ${args.join(' ')}  ${JSON.stringify(env)}`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, stdio: 'inherit', timeout: timeoutMs,
    env: { ...process.env, PERSONA, ...env },
  });
  if (r.error) console.log(`   (${label} error: ${r.error.message})`);
}

function runCycle(cycle, { remoteOnly, titleFilter, label, ats }) {
  const before = counts();
  console.log(`\n\n########## CYCLE ${cycle} [${label}] — SE ${before.se}/${SE_TARGET}, TAM ${before.tam}/${TAM_TARGET}, cloud-total ${before.total} (${new Date().toISOString()}) ##########`);

  // 1. DISCOVER (HTTP only) — append matches to queue-cloud.json.
  const discEnv = { ALLOW_BIG: '1' };
  if (remoteOnly) discEnv.REMOTE_ONLY = '1';
  if (titleFilter) discEnv.TITLE_FILTER = titleFilter;
  step('discover', ['src/discover-api.js', '--ats', ats || ATS_SUBMITTABLE, '--max', DISC_MAX], discEnv, 16 * 60 * 1000);

  // 2. CLEAN — dedupe/remote-filter/sort. In hybrid-TX phase, clean-queue's
  //    remote-only drop would kill hybrid rows, so skip it there and let the
  //    apply runner take the queue as-discovered (discovery already location-gated).
  if (remoteOnly) {
    step('clean-queue', ['src/clean-queue.js'], { ALLOW_BIG: '1' }, 2 * 60 * 1000);
  }

  // 3. APPLY — drain the queue (run-loop stops on 2 dry rounds).
  step('apply', ['src/run-loop.js'], {
    COUNT_PERSONA: PERSONA, GOAL_DATE: '2000-01-01', TARGET: '1000000',
    BATCH: '25', MAX_EVAL: '60', MAX_ROUNDS: '10', MAX_DRY_ROUNDS: '2',
    BATCH_TIMEOUT_MS: String(24 * 60 * 1000), BATCH_PROFILE: APPLY_PROFILE,
  }, 3.5 * 60 * 60 * 1000);

  const after = counts();
  const gain = (after.se - before.se) + (after.tam - before.tam);
  console.log(`\n########## CYCLE ${cycle} DONE — SE ${before.se}->${after.se}, TAM ${before.tam}->${after.tam}, total +${after.total - before.total} (SE/TAM gain ${gain}) ##########`);
  return { after, gain, totalGain: after.total - before.total };
}

// Discovery title families, ALIGNED with the counting regexes so every job we
// collect for a target actually advances that target's count.
const SE_DISC = 'sales engineer|sales engineering|pre[- ]?sales engineer';
const TAM_DISC = 'technical account manager|\\bTAM\\b|technical customer success|technical account executive|customer success engineer|technical engagement manager|technical relationship manager|technical success manager|technical account specialist';

// Escalation ladder — widen the search only when the NEEDED title's supply dries:
//   0: remote-US, submittable boards (greenhouse/ashby/workable)
//   1: remote-US, all boards (adds lever/smartrecruiters)
//   2: hybrid-in-Texas allowed, all boards
//   3: hybrid-TX + broaden titles to full cloud SE/solutions/CS family (bonus)
const LADDER = [
  { remoteOnly: true,  ats: ATS_SUBMITTABLE, broaden: false, label: 'REMOTE/submittable' },
  { remoteOnly: true,  ats: ATS_ALL,         broaden: false, label: 'REMOTE/all-boards' },
  { remoteOnly: false, ats: ATS_ALL,         broaden: false, label: 'HYBRID-TX/all-boards' },
  { remoteOnly: false, ats: ATS_ALL,         broaden: true,  label: 'HYBRID-TX/expand-family' },
];

(async () => {
  console.log(`\n=== SE/TAM AUTOPILOT start — targets SE ${SE_TARGET}, TAM ${TAM_TARGET} ===`);
  let cycle = 0;
  let esc = 0; // escalation level into LADDER

  while (cycle < MAX_CYCLES) {
    cycle++;
    const c = counts();
    const needSE = c.se < SE_TARGET;
    const needTAM = c.tam < TAM_TARGET;
    if (!needSE && !needTAM) {
      console.log(`\n=== BOTH TARGETS MET (SE ${c.se}, TAM ${c.tam}) — stopping ===`);
      break;
    }

    const rung = LADDER[esc];
    // Target ONLY the still-needed title(s) so effort concentrates where it's
    // short (once SE is met, this becomes TAM-only and the queue goes TAM-pure).
    let titleFilter;
    if (rung.broaden) titleFilter = FOCUS_TITLE;            // bonus expand: whole family
    else if (needSE && needTAM) titleFilter = `${SE_DISC}|${TAM_DISC}`;
    else if (needTAM) titleFilter = TAM_DISC;
    else titleFilter = SE_DISC;

    const label = `${rung.label} | need${needSE ? ' SE' : ''}${needTAM ? ' TAM' : ''}`;
    const { after } = runCycle(cycle, { remoteOnly: rung.remoteOnly, titleFilter, ats: rung.ats, label });

    // Gain measured ONLY on the titles we still need.
    const neededGain = (needSE ? after.se - c.se : 0) + (needTAM ? after.tam - c.tam : 0);
    if (neededGain < 2) {
      if (esc < LADDER.length - 1) { esc++; console.log(`\n=== needed-title supply drying (gain ${neededGain}) — escalating to rung ${esc}: ${LADDER[esc].label} ===`); }
      else { console.log(`\n=== Top of ladder reached and supply dry (gain ${neededGain}) — stopping at best effort ===`); break; }
    }
    // On a productive cycle, stay at the current rung and keep mining it.
  }

  const f = counts();
  console.log(`\n=== SE/TAM AUTOPILOT DONE — SE ${f.se}/${SE_TARGET}, TAM ${f.tam}/${TAM_TARGET}, cloud-total ${f.total} ===`);
})();
