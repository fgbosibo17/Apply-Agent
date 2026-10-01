// Tunables. Defaults mirror the thresholds job-application-agent enforces;
// data/agent-config.json (optional, gitignored) overrides any of them, and an
// APPLY_AGENT_* env var overrides that.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // ── Dedup / reapply ──────────────────────────────────────────────────────
  hostBrowserSlots: 0,               // browser runs allowed at once on this host; 0 = auto
                                     // (total PARALLEL_SESSIONS, else 1). See core/locks.js.
  companyReapplyCooldownDays: 9999,  // days before re-applying to the same company. 9999 = never: one company,
                                     // one application, for every persona (see core/company-cap.js for the
                                     // same-role / cross-persona rules). Lower it to allow a second try.
  // ── Scoring gates ────────────────────────────────────────────────────────
  manualReviewFloor: 70,            // below this -> skip
  autoSubmitFloor: 80,              // below this -> manual review only
  mustHaveCoverageFloor: 0.70,      // fraction of must-haves met/partial to auto-submit
  // ── Review cadence ───────────────────────────────────────────────────────
  hygieneReviewEvery: 10,           // submissions between submission-hygiene reviews
  outcomeReviewMinApps: 20,         // apps needed before an outcome-effectiveness review
  outcomeMaturityBusinessDays: 10,  // business days before an app counts as "mature"
  // ── Autonomy ─────────────────────────────────────────────────────────────
  // Default is routine-auto: this agent is run BY its own candidate, at volume,
  // and stopping to confirm every routine submission defeats the point. The
  // guardrail is ALWAYS_STOP in core/autonomy.js plus the `ask` gate from
  // core/score.js — those still stop, in every mode. Set 'review-each' here (or
  // grant it) when you want per-application approval back.
  defaultAutonomyMode: 'routine-auto',
  autonomyGrantMaxHours: 24,
  // ── Machine guards ───────────────────────────────────────────────────────
  // Free space below this refuses to start a round rather than filling the disk
  // mid-run and leaving a half-written ledger with a browser mid-application.
  // Override with APPLY_AGENT_DISK_FREE_FLOOR_GB.
  diskFreeFloorGb: 5,
  // A run guard whose heartbeat is older than this is treated as dead and may be
  // reclaimed. It has to exceed the longest gap between beats — run-loop.js beats
  // between batches and src/index.js beats per job, so minutes, not hours. Long
  // enough to survive a slow application, short enough that a killed run does not
  // block the next night. Override with APPLY_AGENT_LOCK_STALE_MINUTES.
  lockStaleMinutes: 30,
  // ── Tailored resumes ─────────────────────────────────────────────────────
  // How long a RENDERED tailored PDF is kept. The markdown source it came from is
  // kept forever: a few KB that answers "what did this employer see?" months later and
  // regenerates the PDF on demand, versus hundreds of KB per application that turns
  // into gigabytes across a few hundred. Override with
  // APPLY_AGENT_RESUME_RENDER_RETENTION_DAYS.
  resumeRenderRetentionDays: 30,
};

let cache = null;
function config() {
  if (cache) return cache;
  const file = path.resolve(__dirname, '..', '..', 'data', 'agent-config.json');
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* optional */ }
  cache = { ...DEFAULTS, ...fileCfg };
  for (const key of Object.keys(DEFAULTS)) {
    const env = process.env['APPLY_AGENT_' + key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()];
    if (env !== undefined && env !== '') {
      cache[key] = typeof DEFAULTS[key] === 'number' ? Number(env) : env;
    }
  }
  return cache;
}
config.reset = () => { cache = null; };
config.DEFAULTS = DEFAULTS;
module.exports = config;
