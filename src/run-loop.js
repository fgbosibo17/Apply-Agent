// Node-based batch loop — survives Claude Code restarts (a backgrounded node
// process persists; a bash master loop does not). Spawns a FRESH browser batch
// (child `node src/index.js`) each round so the Playwright session never
// degrades, until the cloud-applied total (goal window) reaches TARGET.
//
// Robustness:
//  - WATCHDOG force-kills a hung batch's whole process tree (taskkill /F /T) —
//    execSync's own timeout does NOT reliably kill a frozen Chrome tree on Win.
//  - PROFILE ROTATION: if a batch applies 0 (browser died/corrupted), switch to
//    a fresh profile dir next round so a bad profile can't stall forever.
const { spawn, execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = parseInt(process.env.TARGET || '500', 10);
const BATCH = parseInt(process.env.BATCH || '25', 10);
const MAX_EVAL = parseInt(process.env.MAX_EVAL || '45', 10);
const BASE_PROFILE = process.env.BATCH_PROFILE || 'browser-profile-primary';
const GOAL_DATE = process.env.GOAL_DATE || '2000-01-01';
const COUNT_PERSONA = process.env.COUNT_PERSONA || process.env.PERSONA || 'primary';
const PERSONA_RE = new RegExp('(^|,| )' + COUNT_PERSONA + '(,|\\s*$)', 'i');
const SCRATCH = process.env.SCRATCH || ROOT;
const BATCH_TIMEOUT_MS = parseInt(process.env.BATCH_TIMEOUT_MS || String(40 * 60 * 1000), 10);
const MAX_ROUNDS = 60;

function appliedCount() {
  try {
    const lines = fs.readFileSync(path.join(ROOT, 'applications-log.csv'), 'utf8').split(/\r?\n/).slice(1);
    let c = 0;
    for (const x of lines) {
      if (!x.trim()) continue;
      // Status via a whole-line match (NOT cols[6]) — role titles often contain
      // commas ("SDET, Browser Extension") which shift a naive split and undercount.
      const date = x.split(',', 1)[0];
      if (PERSONA_RE.test(x) && /,Applied,/i.test(x) && date >= GOAL_DATE) c++;
    }
    return c;
  } catch { return 0; }
}

function cleanProfile(profile) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {} }`],
      { stdio: 'ignore', timeout: 30000 });
  } catch {}
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(ROOT, profile, f), { force: true }); } catch {}
  }
}

// Run one batch as a child, with a watchdog that force-kills the whole tree if it
// hangs past BATCH_TIMEOUT_MS. Resolves when the child exits (or is killed).
function runBatch(profile, target, logFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(logFile, 'w');
    const child = spawn(process.execPath, ['src/index.js'], {
      cwd: ROOT,
      env: { ...process.env, PERSONA: process.env.PERSONA || COUNT_PERSONA, BROWSER_PROFILE: profile, SESSION_TARGET: String(target), MAX_EVALUATED: String(MAX_EVAL), CAPTCHA_HITL: '' },
      stdio: ['ignore', out, out],
    });
    let done = false;
    const finish = (how) => { if (done) return; done = true; try { fs.closeSync(out); } catch {} resolve(how); };
    const wd = setTimeout(() => {
      try { execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' }); } catch {}
      finish('timeout');
    }, BATCH_TIMEOUT_MS);
    child.on('exit', () => { clearTimeout(wd); finish('exit'); });
    child.on('error', () => { clearTimeout(wd); finish('error'); });
  });
}

(async () => {
  let profileSeq = 0;
  let profile = BASE_PROFILE + (profileSeq || '');
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const before = appliedCount();
    console.log(`\n=== Round ${round}: cloud applied = ${before} / ${TARGET} | profile ${profile} | ${new Date().toISOString()} ===`);
    if (before >= TARGET) { console.log(`TARGET REACHED (${before})`); break; }
    const t = Math.min(BATCH, TARGET - before);
    cleanProfile(profile);
    const logFile = path.join(SCRATCH, `${COUNT_PERSONA}-nbatch-${round}.log`);
    const how = await runBatch(profile, t, logFile);
    cleanProfile(profile);
    const after = appliedCount();
    const gained = after - before;
    console.log(`--- batch ${round} ended (${how}); +${gained} applied (now ${after}) ---`);
    // If a batch gained nothing, the browser/profile is likely dead → rotate to a
    // fresh profile so we don't stall forever on a corrupted one.
    if (gained === 0) { profileSeq += 1; profile = BASE_PROFILE + profileSeq; console.log(`   rotating to fresh profile: ${profile}`); }
  }
  console.log(`\n=== LOOP DONE. Final cloud applied: ${appliedCount()} / ${TARGET} ===`);
})();
