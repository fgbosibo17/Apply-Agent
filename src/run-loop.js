// Node-based batch loop — survives Claude Code restarts (a backgrounded node
// process persists; a bash master loop does not). Spawns a FRESH browser batch
// (child `node src/index.js`) each round so the Playwright session never
// degrades, until the cloud-applied total (goal window) reaches TARGET.
//
// Robustness:
//  - WATCHDOG force-kills a hung batch's whole process tree (taskkill /F /T) —
//    execSync's own timeout does NOT reliably kill a frozen Chrome tree on Win.
//  - PROFILE REPAIR: if a batch applies 0 (browser died/corrupted), the persona's
//    profile is repaired IN PLACE next round — stale locks and corrupt session/
//    cache dirs are cleared while the signed-in cookies are kept (see
//    src/util/profile.js). This used to walk to a fresh numbered directory
//    instead, which fixed the stall but left the abandoned profile behind
//    forever: that is how this repo grew 23 profile dirs and 5 GB of disk.
const { spawn, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = parseInt(process.env.TARGET || '500', 10);
const BATCH = parseInt(process.env.BATCH || '25', 10);
const MAX_EVAL = parseInt(process.env.MAX_EVAL || '45', 10);
// The persona owns its profile (src/personas.js derives browser-profile-<persona>).
// BATCH_PROFILE still overrides it for a one-off, but it no longer DEFAULTS to a
// hardcoded name — that default is what silently pointed cloud/qa runs at
// whichever profile was fashionable and multiplied the directories.
const { repairProfile } = require('./util/profile');
const COUNT_PERSONA = process.env.COUNT_PERSONA || process.env.PERSONA || 'cloud';
// The profile directory comes from the persona's profileKey, so cloud and fullstack
// resolve to the SAME directory — they are one identity with one browser account.
// Rebuilding `browser-profile-<persona>` here would have re-created the extra
// directory the profileKey change exists to remove.
const { profileKeyFor, profileDirFor } = require('./personas');
const BASE_PROFILE = process.env.BATCH_PROFILE
  || path.basename(profileDirFor(COUNT_PERSONA) || `browser-profile-${COUNT_PERSONA}`);
// Batch logs go to the owner-only state dir, NOT the repo root. They open with
// "Persona: <name> <email>" and then list every job URL evaluated, and the root
// copies were not even gitignored — a `git add -A` would have committed them.
const SCRATCH = process.env.SCRATCH || require('./core/paths').runLogs();
const BATCH_TIMEOUT_MS = parseInt(process.env.BATCH_TIMEOUT_MS || String(40 * 60 * 1000), 10);
const MAX_ROUNDS = parseInt(process.env.MAX_ROUNDS || '60', 10);
// Stop early if this many consecutive batches gain 0 (queue exhausted) — avoids
// burning dozens of empty rounds once real supply is drained.
const MAX_DRY_ROUNDS = parseInt(process.env.MAX_DRY_ROUNDS || '4', 10);
// One round ID spans every fresh-browser batch, so the whole loop is a single
// addressable unit in the ledger instead of N unrelated sessions.
const rounds = require('./core/rounds');
// ROUND_ID lets an outer entry point (scripts/run-persona.sh) open the round, so the
// round id is addressable from the shell before any browser starts — and so the
// preflight that `round start` performs happens exactly once, up front, rather than
// again here. Without it the loop opens its own round, as it always did.
const locks = require('./core/locks');
const stopflag = require('./core/stopflag');
const OUTER_ROUND_ID = process.env.ROUND_ID || '';

// Opening the round is what takes the guards, so a refusal happens here — before any
// browser, and with a message that says which guard refused and what to do.
function openRound() {
  const existing = OUTER_ROUND_ID && rounds.status(OUTER_ROUND_ID);
  if (existing) return existing;
  try {
    return rounds.start({
      id: OUTER_ROUND_ID || undefined,
      persona: process.env.PERSONA || COUNT_PERSONA,
      target: TARGET,
      maxEvaluated: MAX_EVAL,
      note: `run-loop: batch=${BATCH}, maxRounds=${MAX_ROUNDS}`,
    });
  } catch (e) {
    if (e instanceof locks.GuardRefusedError) {
      console.error(`run-loop: refusing to start — ${e.guard}`);
      console.error(`  ${e.message}`);
      console.error(e.guard === locks.SEMAPHORE
        ? '  -> One browser run per host. Wait, or run on the other machine.'
        : '  -> Wait for the holder, or run a persona on a different profile.');
      console.error('  Inspect: npm run agent -- round locks');
      process.exit(1);
    }
    throw e;
  }
}
const LOOP_ROUND = openRound();

// This process owns the round for the whole loop, so it owns the guards: it takes
// their pid over from whoever opened the round, beats between batches, and releases
// on every exit path. The batch children inherit ROUND_ID and never acquire.
const GUARD = {
  roundId: LOOP_ROUND.id,
  profileKey: LOOP_ROUND.profileKey || profileKeyFor(COUNT_PERSONA) || COUNT_PERSONA,
};
rounds.adopt(GUARD);

let guardsReleased = false;
function releaseGuards() {
  if (guardsReleased) return;
  guardsReleased = true;
  try { rounds.release(GUARD); } catch { /* best effort */ }
}
// A killed loop must not keep the profile locked until the staleness threshold
// expires — the next scheduled run is tonight.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { releaseGuards(); process.exit(130); });
}
process.on('exit', releaseGuards);
process.on('uncaughtException', (e) => {
  releaseGuards();
  console.error('run-loop: uncaught exception —', e && e.message);
  process.exit(1);
});

// Progress, from the ledger, scoped to THIS round.
//
// This used to parse applications-log.csv and count rows whose date was >= a
// hardcoded GOAL_DATE ('2026-06-27') for a persona matched by regex against the
// whole line. Three problems: the legacy CSV is no longer the source of truth, the
// date window silently went stale (every row from the goal window counts forever, so
// months later the count starts above TARGET and the loop exits immediately having
// done nothing), and it measured lifetime totals rather than this run's progress.
//
// rounds.status() reads the NDJSON ledger and counts rows with status 'submitted'
// carrying this round id — the same number `apply-agent round status <id>` reports,
// which is what scripts/run-persona.sh prints. TARGET now means "this many
// submissions in this run", which is what a caller passing a target intends.
function appliedCount() {
  try {
    const st = rounds.status(LOOP_ROUND.id);
    return st ? st.submitted : 0;
  } catch { return 0; }
}

const IS_WIN = process.platform === 'win32';

function cleanProfile(profile) {
  try {
    if (IS_WIN) {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`],
        { stdio: 'ignore', timeout: 30000 });
    } else {
      // macOS/Linux: kill any Chrome still holding this profile dir. pkill exits
      // 1 when nothing matched, which execFileSync throws on — that's fine.
      execFileSync('pkill', ['-f', `--user-data-dir=.*${profile}`], { stdio: 'ignore', timeout: 30000 });
    }
  } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(ROOT, profile, f), { force: true }); } catch {}
  }
}

// Force-kill a batch child and everything it spawned (Chrome), cross-platform.
function killTree(pid) {
  if (IS_WIN) {
    try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch {}
    return;
  }
  // POSIX: the child is its own process-group leader (detached below), so a
  // negative pid signals the whole group — child plus every Chrome it started.
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

// Run one batch as a child, with a watchdog that force-kills the whole tree if it
// hangs past BATCH_TIMEOUT_MS. Resolves when the child exits (or is killed).
function runBatch(profile, target, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PERSONA: process.env.PERSONA || COUNT_PERSONA, BROWSER_PROFILE: profile, SESSION_TARGET: String(target), MAX_EVALUATED: String(MAX_EVAL), CAPTCHA_HITL: '', ROUND_ID: LOOP_ROUND.id },
      stdio: ['ignore', out, out],
      // POSIX: give the batch its own process group so the watchdog can kill the
      // child AND the Chrome tree it spawned in one signal (see killTree).
      detached: !IS_WIN,
    });
    let done = false;
    const finish = (how) => { if (done) return; done = true; try { fs.closeSync(out); } catch {} resolve(how); };
    const wd = setTimeout(() => {
      killTree(child.pid);
      finish('timeout');
    }, BATCH_TIMEOUT_MS);
    child.on('exit', () => { clearTimeout(wd); finish('exit'); });
    child.on('error', () => { clearTimeout(wd); finish('error'); });
  });
}

(async () => {
  // Refresh the live discovery sources ONCE, before the first browser launches.
  // TTL-guarded and non-fatal (src/prerun.js), so it is a no-op on a recent pull
  // and never keeps a batch from starting. Deliberately here and not inside
  // runBatch: discovery must not share the network with an apply batch.
  try { require('./prerun').refresh(); } catch (e) { console.log(`[prerun] skipped: ${e.message}`); }

  // One profile for the whole loop — no rotation, no new directories.
  const profile = BASE_PROFILE;
  let dryRounds = 0;
  let stoppedBy = null;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const before = appliedCount();
    console.log(`\n=== Batch ${round}: ${COUNT_PERSONA} submitted = ${before} / ${TARGET} | profile ${profile} | ${new Date().toISOString()} ===`);
    if (before >= TARGET) { console.log(`TARGET REACHED (${before})`); break; }
    const t = Math.min(BATCH, TARGET - before);
    cleanProfile(profile);
    // Scoped by the loop's round id so a second invocation does not overwrite the
    // first one's logs (the old `<persona>-nbatch-<round>.log` name collided on
    // every re-run).
    const logFile = path.join(SCRATCH, `${COUNT_PERSONA}-${LOOP_ROUND.id}-batch-${round}.log`);
    const how = await runBatch(profile, t, logFile);
    cleanProfile(profile);
    // Between batches: prove the loop is alive even if a batch died early and did no
    // beating of its own.
    try { rounds.heartbeat(GUARD); } catch { /* never fail the loop over a heartbeat */ }
    // One batch done, recorded in the round so `round status` shows batch progress and
    // not just job counts.
    try { require('./core/progress').record(LOOP_ROUND.id, { batches: 1 }); } catch { /* observability only */ }

    // A stop asked for mid-batch was already honoured by the child, which finished its
    // job and exited. Stop launching new batches too.
    const stopReq = stopflag.read(LOOP_ROUND.id);
    if (stopReq) {
      console.log(`\n⏹ stop requested by ${stopReq.requestedBy}${stopReq.reason ? ` (${stopReq.reason})` : ''} — no further batches.`);
      stoppedBy = stopReq;
      break;
    }
    const after = appliedCount();
    const gained = after - before;
    console.log(`--- batch ${round} ended (${how}); +${gained} applied (now ${after}) ---`);
    // If a batch gained nothing, the browser/profile is likely wedged → repair it
    // in place (clear stale locks and corrupt session/cache dirs, keep the login)
    // rather than abandoning it for a new directory.
    if (gained === 0) {
      dryRounds += 1;
      const r = repairProfile(path.join(ROOT, profile));
      console.log(`   gained 0 (dry ${dryRounds}/${MAX_DRY_ROUNDS}); repaired ${profile}`
        + (r.repaired ? ` — cleared ${r.removed.length} stale item(s)` : ' — nothing stale to clear'));
      if (dryRounds >= MAX_DRY_ROUNDS) { console.log(`   ${MAX_DRY_ROUNDS} consecutive dry rounds — supply exhausted, stopping.`); break; }
    } else {
      dryRounds = 0;
    }
  }
  // complete() releases both guards; mark them done so the exit handler is a no-op.
  // A stopped loop still completes the round record — an open round keeps its lock until
  // the staleness threshold expires, which would cost tonight's run.
  const summary = rounds.complete({
    id: LOOP_ROUND.id,
    note: stoppedBy ? `stopped at ${appliedCount()}/${TARGET}` : `finished at ${appliedCount()}/${TARGET}`,
    stopped: stoppedBy ? { reason: stoppedBy.reason || 'requested', requestedBy: stoppedBy.requestedBy, force: !!stoppedBy.force } : undefined,
  });
  guardsReleased = true;
  console.log(`\n=== LOOP DONE. Final ${COUNT_PERSONA} submitted: ${appliedCount()} / ${TARGET} ===`);
  console.log(`Round ${summary.id}: ${summary.submitted} ledger submission(s), ${summary.attentionOpen} attention item(s) open.`);
})();
