// Pre-run source refresh — pulls the live discovery sources before a run starts.
//
// The community job registry (src/discover-community.js) only changes when other
// installations confirm new applications, so it has to be re-pulled to be worth
// anything. This module is the single place that decides WHEN, and it is wired
// into every path that starts a run:
//
//   npm run apply / npm run discover   -> npm `preapply` / `prediscover` hooks
//   node src/autopilot.js              -> one refresh step per cycle, before discover
//   node src/run-loop.js               -> once, before the first browser batch
//
// Three rules keep it from getting in the way:
//
//   1. TTL-GUARDED. A stamp in .state/prerun.json records the last successful
//      pull per task. Inside the TTL it is a no-op, so a 10-round run-loop or a
//      14-cycle autopilot does not refetch 300 rows every few minutes.
//   2. NEVER FATAL. It always exits 0 and always resolves. A dead registry, a
//      flaky network or a parse change must never abort an apply run — least of
//      all through an npm `pre` hook, which would take the whole command down.
//   3. BEFORE, NOT DURING. It runs to completion before any browser launches,
//      honouring the repo rule that discovery never shares the network with an
//      apply batch.
//
//   node src/prerun.js                 # refresh if stale
//   node src/prerun.js --force         # refresh now
//   node src/prerun.js --status        # show staleness, pull nothing
//   SKIP_PRERUN=1 ...                  # disable entirely for one run
//   SOURCE_REFRESH_TTL_MIN=60 ...      # tighten/loosen the TTL (default 360)

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const paths = require('./core/paths');

const ROOT = path.resolve(__dirname, '..');
const STAMP = () => paths.statePath('prerun.json');

const TTL_MIN = parseInt(process.env.SOURCE_REFRESH_TTL_MIN || '360', 10);
const TIMEOUT_MS = parseInt(process.env.PRERUN_TIMEOUT_MS || '180000', 10);
const SKIP = /^(1|true|yes)$/i.test(process.env.SKIP_PRERUN || '');

// Refreshable sources. `args` run as a child node process so a crash in one
// cannot take the run down with it. Add a task here and every entry point picks
// it up — that is the point of having one module.
const TASKS = [
  {
    id: 'community',
    label: 'community job registry',
    args: ['src/discover-community.js', '--pages', process.env.PRERUN_COMMUNITY_PAGES || '10'],
    // Lines worth echoing from the child's output (it prints a full report).
    keep: /^(Fetched|Tokens seen|Added|Re-verified|Queued|  dropped)/,
    // A clean exit is NOT proof of a pull: discover-community.js deliberately
    // degrades to "Fetched 0" when the registry is unreachable, and treating that
    // as success would reset the TTL and hide an outage for six hours. Require
    // evidence that rows actually arrived.
    succeeded: (out) => {
      const m = out.match(/Fetched (\d+) confirmed community job links/);
      return !!m && Number(m[1]) > 0;
    },
  },
];

function readStamp() {
  try { return JSON.parse(fs.readFileSync(STAMP(), 'utf8')); } catch { return {}; }
}

function writeStamp(stamp) {
  try {
    fs.writeFileSync(STAMP(), JSON.stringify(stamp, null, 2), { mode: 0o600 });
  } catch { /* a stamp we cannot persist just means we refresh again next run */ }
}

const ageMin = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? Infinity : (Date.now() - t) / 60000;
};

function status() {
  const stamp = readStamp();
  return TASKS.map((t) => {
    const rec = stamp[t.id] || {};
    const age = ageMin(rec.lastRunAt);
    return {
      id: t.id,
      label: t.label,
      lastRunAt: rec.lastRunAt || null,
      ageMinutes: age === Infinity ? null : Math.round(age),
      stale: age >= TTL_MIN,
      lastResult: rec.note || null,
    };
  });
}

// Run one task as a child process. Returns a short note; never throws.
function runTask(task) {
  const r = spawnSync(process.execPath, task.args, {
    cwd: ROOT,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
    // PERSONA is inherited on purpose: with it set the task also queues matching
    // leads, without it the task only grows data/companies.json.
    env: process.env,
  });
  if (r.error) {
    const why = r.error.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT_MS}ms` : r.error.message;
    return { ok: false, note: `failed: ${why}` };
  }
  const out = `${r.stdout || ''}\n${r.stderr || ''}`;
  const lines = out.split(/\r?\n/).filter((l) => task.keep.test(l));
  lines.forEach((l) => console.log(`  ${l.trim()}`));
  const note = lines.map((l) => l.trim()).join(' | ').slice(0, 300) || 'no output';
  if (r.status !== 0) return { ok: false, note: `exit ${r.status}` };
  if (task.succeeded && !task.succeeded(out)) return { ok: false, note: `no rows returned (${note})` };
  return { ok: true, note };
}

// Refresh every stale source. Synchronous by design: callers need it finished
// before they launch a browser or start a sweep.
function refresh({ force = false, quiet = false } = {}) {
  if (SKIP) {
    if (!quiet) console.log('[prerun] SKIP_PRERUN set — not refreshing sources.');
    return { skipped: true, ran: [] };
  }
  const stamp = readStamp();
  const ran = [];
  for (const task of TASKS) {
    const age = ageMin((stamp[task.id] || {}).lastRunAt);
    if (!force && age < TTL_MIN) {
      if (!quiet) console.log(`[prerun] ${task.label}: fresh (${Math.round(age)}m old, TTL ${TTL_MIN}m) — skipping.`);
      continue;
    }
    if (!quiet) {
      const why = age === Infinity ? 'never pulled' : `${Math.round(age)}m old`;
      console.log(`[prerun] ${task.label}: ${force ? 'forced' : why} — refreshing...`);
    }
    const result = runTask(task);
    ran.push({ id: task.id, ...result });
    // Only a SUCCESSFUL pull resets the clock, so an outage retries next run
    // instead of being papered over for the whole TTL.
    if (result.ok) {
      stamp[task.id] = { lastRunAt: new Date().toISOString(), note: result.note };
    } else {
      stamp[task.id] = { ...(stamp[task.id] || {}), lastAttemptAt: new Date().toISOString(), note: result.note };
      if (!quiet) console.log(`[prerun] ${task.label}: ${result.note} — continuing anyway.`);
    }
  }
  writeStamp(stamp);
  return { skipped: false, ran };
}

module.exports = { refresh, status, TTL_MIN };

if (require.main === module) {
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify(status(), null, 2));
  } else {
    // Always exit 0: this must never be the reason a run does not happen.
    try { refresh({ force: process.argv.includes('--force') }); } catch (e) {
      console.log(`[prerun] refresh error (ignored): ${e.message}`);
    }
  }
  process.exit(0);
}
