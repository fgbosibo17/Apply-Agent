// Gate-before-score fit assessment.
//
// The repo's old filter was a single scalar (MIN_MATCH_SCORE: 7). This is
// job-application-agent's four-way contract: a gate decision is made FIRST from
// hard facts (posting status, eligibility, exclusions), and the numeric score
// only matters once the gate says `review`. `autoEligible` is deliberately
// stricter than the gate — it is necessary but never sufficient to submit.
const config = require('./config');
const { companyKey } = require('./canonical');

const SENIORITY_ORDER = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'director'];
const MUST_HAVE_STATUS = ['met', 'partial', 'missing', 'unclear'];

function normSeniority(s) {
  const t = String(s || '').toLowerCase();
  if (/\bintern\b/.test(t)) return 'intern';
  if (/\b(junior|entry|associate|new grad|graduate|i\b)/.test(t)) return 'junior';
  if (/\b(principal|distinguished|fellow)\b/.test(t)) return 'principal';
  if (/\b(director|head of|vp|vice president)\b/.test(t)) return 'director';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(senior|sr\.?|lead|architect|manager)\b/.test(t)) return 'senior';
  if (/\b(mid|intermediate|ii|iii)\b/.test(t)) return 'mid';
  return '';
}

function coverage(mustHaves) {
  const list = Array.isArray(mustHaves) ? mustHaves : [];
  if (!list.length) return { total: 0, met: 0, partial: 0, missing: 0, unclear: 0, ratio: null };
  const c = { total: list.length, met: 0, partial: 0, missing: 0, unclear: 0 };
  for (const m of list) {
    const st = MUST_HAVE_STATUS.includes(m && m.status) ? m.status : 'unclear';
    c[st]++;
  }
  // A partial counts as half — an "adjacent experience" claim is not a match.
  c.ratio = +(((c.met + c.partial * 0.5) / c.total).toFixed(3));
  return c;
}

/**
 * @param {object} job     posting facts, as extracted from the JD
 * @param {object} profile candidate targeting facts (persona-derived)
 * @returns {{gate:string, score:number|null, autoEligible:boolean, reasons:string[], coverage:object}}
 */
function score(job = {}, profile = {}) {
  const cfg = config();
  const reasons = [];
  const cov = coverage(job.mustHaves);

  const targetSeniority = (profile.targetSeniority || ['senior', 'staff', 'principal']).map(normSeniority).filter(Boolean);
  const jobSeniority = normSeniority(job.seniority || job.title);
  const excludedCompanies = new Set((profile.excludedCompanies || []).map(companyKey));
  const excludedLocations = (profile.excludedLocations || []).map((s) => String(s).toLowerCase());

  // ── exclude: hard, factual disqualifiers ────────────────────────────────
  const exclude = [];
  if (job.postingStatus === 'closed') exclude.push('posting is closed');
  if (job.eligible === false) exclude.push('explicitly ineligible (stated requirement the candidate cannot meet)');
  if (job.company && excludedCompanies.has(companyKey(job.company))) exclude.push(`excluded company: ${job.company}`);
  if (job.requiresCitizenship && profile.usCitizen === false) exclude.push('requires US citizenship');
  if (job.requiresClearance && !profile.hasClearance) exclude.push('requires an active security clearance');
  if (job.requiresSponsorship === false && profile.needsSponsorship === true) exclude.push('no sponsorship offered and sponsorship is required');
  const locs = (job.locations || []).map((s) => String(s).toLowerCase());
  if (locs.length && excludedLocations.length && locs.every((l) => excludedLocations.some((x) => l.includes(x)))) {
    exclude.push(`all listed locations excluded: ${job.locations.join(', ')}`);
  }
  const workMode = String(job.workMode || '').toLowerCase();
  const okModes = (profile.workModes || ['remote', 'hybrid']).map((s) => s.toLowerCase());
  if (workMode && !okModes.some((m) => workMode.includes(m))) exclude.push(`incompatible work mode: ${job.workMode}`);
  if (exclude.length) {
    return { gate: 'exclude', score: null, autoEligible: false, reasons: exclude, coverage: cov };
  }

  // ── ask: anything genuinely unclear goes to a human, never to a guess ────
  const ask = [];
  if (!job.postingStatus || job.postingStatus === 'unclear') ask.push('posting status unverified');
  if (job.eligible === undefined || job.eligible === null) ask.push('eligibility not assessed');
  if (job.workAuthClear === false) ask.push('work authorization requirement unclear');
  if (!job.workMode) ask.push('work mode not stated');
  if (!jobSeniority) ask.push('seniority not stated');
  if (cov.total === 0) ask.push('must-have requirements were not extracted');
  if (cov.unclear > 0) ask.push(`${cov.unclear} must-have requirement(s) unclear`);
  if (job.compensationAskedOfCandidate) ask.push('application asks the candidate to state or accept compensation');
  if (ask.length) {
    return { gate: 'ask', score: null, autoEligible: false, reasons: ask, coverage: cov };
  }

  // ── numeric score (only meaningful past the gates) ───────────────────────
  const seniorityExact = targetSeniority.includes(jobSeniority);
  const seniorityAdjacent = !seniorityExact && targetSeniority.some(
    (t) => Math.abs(SENIORITY_ORDER.indexOf(t) - SENIORITY_ORDER.indexOf(jobSeniority)) === 1);

  let s = 0;
  s += 55 * cov.ratio;                                     // must-have evidence
  s += seniorityExact ? 15 : seniorityAdjacent ? 7 : 0;     // level fit
  s += okModes.some((m) => workMode.includes(m)) ? 10 : 0;  // work mode
  // Compensation: unknown never penalises (their rule), it just earns nothing.
  const floor = profile.compensationFloor;
  const compMax = job.compensationMax;
  if (floor && compMax) s += compMax >= floor ? 10 : 0;
  else if (!compMax) s += 6;
  const empOk = !job.employmentType || (profile.employmentTypes || ['full-time', 'contract'])
    .some((t) => String(job.employmentType).toLowerCase().includes(t));
  s += empOk ? 10 : 0;
  const finalScore = Math.max(0, Math.min(100, Math.round(s)));

  // ── skip: on-target but not worth an application ────────────────────────
  const skip = [];
  if (jobSeniority && !seniorityExact && !seniorityAdjacent) {
    skip.push(`explicit non-target seniority: ${jobSeniority}`);
  }
  if (floor && compMax && compMax < floor) {
    skip.push(`published compensation max ${compMax} below floor ${floor}`);
  }
  if (cov.ratio !== null && cov.ratio < 0.5) {
    skip.push(`insufficient must-have coverage: ${Math.round(cov.ratio * 100)}%`);
  }
  if (finalScore < cfg.manualReviewFloor) {
    skip.push(`score ${finalScore} below manual-review floor ${cfg.manualReviewFloor}`);
  }
  if (skip.length) {
    return { gate: 'skip', score: finalScore, autoEligible: false, reasons: skip, coverage: cov };
  }

  // ── review + auto-eligibility ───────────────────────────────────────────
  const autoBlockers = [];
  if (!seniorityExact) autoBlockers.push('seniority is adjacent, not exact');
  if (finalScore < cfg.autoSubmitFloor) autoBlockers.push(`score ${finalScore} below auto-submit floor ${cfg.autoSubmitFloor}`);
  if (cov.ratio < cfg.mustHaveCoverageFloor) autoBlockers.push(`must-have coverage ${Math.round(cov.ratio * 100)}% below ${Math.round(cfg.mustHaveCoverageFloor * 100)}%`);
  if (job.experienceMismatch) autoBlockers.push('material experience-range mismatch');

  reasons.push(`score ${finalScore}`, `must-have coverage ${Math.round(cov.ratio * 100)}%`);
  if (autoBlockers.length) reasons.push('manual review required: ' + autoBlockers.join('; '));

  return {
    gate: 'review',
    score: finalScore,
    autoEligible: autoBlockers.length === 0,
    autoBlockers,
    reasons,
    coverage: cov,
  };
}

module.exports = { score, coverage, normSeniority, SENIORITY_ORDER, MUST_HAVE_STATUS };
