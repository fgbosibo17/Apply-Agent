// Tunables. Defaults mirror the thresholds job-application-agent enforces;
// data/agent-config.json (optional, gitignored) overrides any of them, and an
// APPLY_AGENT_* env var overrides that.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // ── Dedup / reapply ──────────────────────────────────────────────────────
  companyReapplyCooldownDays: 15,   // days before re-applying to the same company
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
