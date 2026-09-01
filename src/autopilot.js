// Autonomous "grind to target" wrapper for the QA 250-run (2026-06-30).
// Repeats DISCOVER -> CLEAN -> APPLY cycles (strictly sequential — never runs
// discovery during an apply batch, per the network-saturation rule) until the
// QA applied-since-GOAL_DATE count reaches TARGET, or supply dries up (N cycles
// with < MIN_GAIN new applies), or MAX_CYCLES is hit.
//
// Honors the user's constraints via env: REMOTE_ONLY=1 (no hybrid) and
// ALLOW_BIG=1 (mid/large companies allowed — user relaxed this to reach 250).
// Personal-exclude (juniper square, akuity) is always enforced in discovery.
//
//   TARGET=576 GOAL_DATE=2026-06-30 node src/autopilot.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = parseInt(process.env.TARGET || '576', 10);
const GOAL_DATE = process.env.GOAL_DATE || '2026-06-30';
const PERSONA = process.env.PERSONA || 'qa';
const MAX_CYCLES = parseInt(process.env.MAX_CYCLES || '14', 10);
const MIN_GAIN = parseInt(process.env.MIN_GAIN || '3', 10);   // a cycle gaining < this = "dry"
const MAX_DRY_CYCLES = parseInt(process.env.MAX_DRY_CYCLES || '2', 10);
const PERSONA_RE = new RegExp('(^|,| )' + PERSONA + '(,|\\s*$)', 'i');

function appliedCount() {
  try {
    return fs.readFileSync(path.join(ROOT, 'applications-log.csv'), 'utf8')
      .split(/\r?\n/).slice(1)
      .filter((x) => x.trim() && PERSONA_RE.test(x) && /,Applied,/i.test(x) && x.split(',', 1)[0] >= GOAL_DATE).length;
  } catch { return 0; }
}

function step(label, args, env, timeoutMs) {
  console.log(`\n[${new Date().toISOString()}] ${label}: node ${args.join(' ')}`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, stdio: 'inherit', timeout: timeoutMs,
    env: { ...process.env, PERSONA, ...env },
  });
  if (r.error) console.log(`   (${label} error: ${r.error.message})`);
}

(async () => {
  let dryCycles = 0;
  console.log(`\n=== AUTOPILOT start — target ${TARGET}, current ${appliedCount()} (${PERSONA}, since ${GOAL_DATE}) ===`);
  for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
    const before = appliedCount();
    if (before >= TARGET) { console.log(`\n=== TARGET REACHED (${before}/${TARGET}) ===`); break; }
    console.log(`\n\n########## CYCLE ${cycle} — ${before}/${TARGET} (${new Date().toISOString()}) ##########`);

    // ── 0. REFRESH live sources (TTL-guarded; before discover so any new board
    // tokens it harvests are swept in THIS cycle, not the next one) ──────────
    step('prerun', ['src/prerun.js'], {}, 5 * 60 * 1000);

    // ── 1. DISCOVER (HTTP only; safe to run to completion before any apply) ──
    // Ashby is the main supply; greenhouse next; lever/SR are captcha-walled but
    // some slip through. REMOTE_ONLY + ALLOW_BIG per the user's constraints.
    const disc = { REMOTE_ONLY: '1', ALLOW_BIG: '1' };
    if (process.env.RECENT_DAYS) disc.RECENT_DAYS = process.env.RECENT_DAYS; // recency filter
    // ATS(es) to sweep are configurable (DISC_ATS); defaults to ashby. For cloud
    // volume we sweep greenhouse+ashby (+lever) with a recency filter.
    step('discover', ['src/discover-api.js', '--ats', process.env.DISC_ATS || 'ashby', '--max', process.env.DISC_MAX || '800'], disc, 13 * 60 * 1000);

    // ── 2. CLEAN (remote-only, big-cos allowed, drop seen/excluded, sort) ──
    step('clean-queue', ['src/clean-queue.js'], { ALLOW_BIG: '1' }, 2 * 60 * 1000);

    // ── 3. APPLY until this cycle's queue drains (fresh browser per batch) ──
    // MAX_EVAL kept modest so batches finish inside the timeout (30s/job avg).
    step('apply', ['src/run-loop.js'], {
      COUNT_PERSONA: PERSONA, GOAL_DATE, TARGET: String(TARGET),
      BATCH: '25', MAX_EVAL: '40', MAX_ROUNDS: '10', MAX_DRY_ROUNDS: '2',
      // No hardcoded profile name: run-loop derives browser-profile-<persona>.
      // APPLY_PROFILE still overrides for a one-off.
      BATCH_TIMEOUT_MS: String(24 * 60 * 1000), ...(process.env.APPLY_PROFILE ? { BATCH_PROFILE: process.env.APPLY_PROFILE } : {}),
    }, 3.5 * 60 * 60 * 1000);

    const after = appliedCount();
    const gain = after - before;
    console.log(`\n########## CYCLE ${cycle} DONE — ${before} -> ${after} (+${gain}) ##########`);
    if (gain < MIN_GAIN) {
      dryCycles++;
      console.log(`   low-gain cycle (${dryCycles}/${MAX_DRY_CYCLES})`);
      if (dryCycles >= MAX_DRY_CYCLES) { console.log(`\n=== SUPPLY EXHAUSTED after ${cycle} cycles — stopping at ${after}/${TARGET} ===`); break; }
    } else {
      dryCycles = 0;
    }
  }
  console.log(`\n=== AUTOPILOT DONE — final ${appliedCount()}/${TARGET} ===`);
})();
