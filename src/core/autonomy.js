// Autonomy modes and time-boxed grants.
//
// APPLY_MODE in CLAUDE.md is a comment the agent may or may not honour. This is
// the enforceable version: `routine-auto` (the default) allows routine
// submissions, `review-each` requires per-application approval. Neither mode can
// touch alwaysStop — those stop regardless. A grant expires on its own, so an
// explicit escalation is never permanent; the DEFAULT mode does not expire,
// because asking the candidate to re-authorise their own batch run every 24h is
// friction with no safety payoff.
const fs = require('fs');
const paths = require('./paths');
const config = require('./config');

const MODES = ['review-each', 'routine-auto'];

// Non-negotiable: no mode or grant can auto-answer these.
const ALWAYS_STOP = [
  'password, SSO, MFA',
  'CAPTCHA',
  'legal attestations and government identifiers',
  'demographic / voluntary self-identification beyond stored persona values',
  'unclear work authorization, sponsorship, location, or compensation',
  'any claim not verifiable from the persona or resume',
  'browser or OS permission prompts',
];

function read() {
  try { return JSON.parse(fs.readFileSync(paths.autonomy(), 'utf8')); } catch { return null; }
}
function write(v) {
  fs.writeFileSync(paths.autonomy(), JSON.stringify(v, null, 2), { mode: 0o600 });
}

function status(now = new Date().toISOString()) {
  const cfg = config();
  const g = read();
  if (!g) return { mode: cfg.defaultAutonomyMode, granted: false, expired: false, alwaysStop: ALWAYS_STOP };
  const expired = !g.expiresAt || g.expiresAt <= now;
  return {
    mode: expired ? cfg.defaultAutonomyMode : g.mode,
    granted: !expired,
    expired,
    grantedAt: g.grantedAt,
    expiresAt: g.expiresAt,
    scope: g.scope || null,
    alwaysStop: ALWAYS_STOP,
  };
}

function grant(input = {}) {
  const cfg = config();
  if (!MODES.includes(input.mode)) throw new Error(`autonomy grant: mode must be one of ${MODES.join(', ')}`);
  const hours = Math.min(Number(input.hours) || cfg.autonomyGrantMaxHours, cfg.autonomyGrantMaxHours);
  const grantedAt = new Date().toISOString();
  const record = {
    mode: input.mode,
    grantedAt,
    expiresAt: new Date(Date.now() + hours * 3600 * 1000).toISOString(),
    hours,
    // A grant can be narrowed to one persona / one batch.
    scope: {
      persona: input.persona || null,
      roundId: input.roundId || null,
      maxSubmissions: Number(input.maxSubmissions) || null,
    },
    note: (input.note || '').slice(0, 300),
  };
  write(record);
  return record;
}

function revoke() {
  try { fs.unlinkSync(paths.autonomy()); } catch { /* already gone */ }
  return status();
}

// The question a runner actually asks: may I submit this one without asking?
function canAutoSubmit({ autoEligible, gate, persona, roundId, submittedThisRound = 0 } = {}) {
  const st = status();
  const reasons = [];
  if (st.mode !== 'routine-auto') reasons.push(`autonomy mode is ${st.mode}`);
  if (gate !== 'review') reasons.push(`gate is ${gate || 'unset'}, not review`);
  if (autoEligible !== true) reasons.push('not autoEligible');
  const scope = (st.granted && st.scope) || {};
  if (scope.persona && persona && scope.persona !== persona) reasons.push(`grant is scoped to persona ${scope.persona}`);
  if (scope.roundId && roundId && scope.roundId !== roundId) reasons.push(`grant is scoped to round ${scope.roundId}`);
  if (scope.maxSubmissions && submittedThisRound >= scope.maxSubmissions) reasons.push(`grant cap ${scope.maxSubmissions} reached`);
  return { allowed: reasons.length === 0, mode: st.mode, reasons, alwaysStop: ALWAYS_STOP };
}

module.exports = { status, grant, revoke, canAutoSubmit, MODES, ALWAYS_STOP };
