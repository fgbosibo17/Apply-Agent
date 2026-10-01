// Essay answers written for THIS persona and THIS posting.
//
// WHY A PRE-PASS INSTEAD OF AN ASYNC generateAnswer
//
// generateAnswer() is called from five places, two of them inside sync helpers
// (valueForLabel, textValueForLabel) that sit in a short-circuit chain:
//
//     let val = valueForLabel(q.label) || textValueForLabel(q.label, a) || getLearned(q.label);
//
// Making generation async forces those helpers async, and a pending Promise is
// truthy — so that chain would silently take the first branch every time and never
// consult the others. The bug would not throw; it would just quietly fill forms
// with the wrong value. That is the same shape as every other failure this system
// has produced tonight, so the refactor that invites it is the wrong one.
//
// Instead: resolve every open-ended question ONCE, before filling starts, into a
// cache. The call sites stay synchronous and read the cache.
//
// WHAT WAS WRONG BEFORE
// answer-bank.js matched rules against the QUESTION's keywords with no idea which
// persona was applying. Its rule list holds QA rules and Cloud rules together, so a
// question mentioning cloud got the Cloud answer — "9+ years hands-on with AWS and
// Azure across multi-account production environments" — sent under the QA persona.
// The rule fired correctly by its own logic. It simply had no persona.
//
// A CACHE MISS RETURNS NULL, DELIBERATELY
// If no model was reachable, the honest outcome is an empty field: required means
// the form blocks and the job is skipped with an attention item; optional means it
// stays blank. Both beat a confident paragraph about experience the candidate does
// not have.

// ── talking to Prime's generic inference endpoint ────────────────────────────────
// Derived from the tailor endpoint so there is one URL to configure, not two.
const orchestrator = require('./util/orchestrator');

function inferUrl() {
  const t = orchestrator.tailorEndpoint && orchestrator.tailorEndpoint();
  return t ? String(t).replace(/\/tailor\b/, '/infer') : '';
}

async function infer({ system, prompt, model = 'haiku', maxTokens = 500 }) {
  const url = inferUrl();
  if (!url) throw new Error('no inference endpoint configured');
  const token = (orchestrator.serviceToken && orchestrator.serviceToken()) || '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.APPLY_AGENT_TAILOR_TIMEOUT_MS || 120000));
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ model, system, prompt, max_tokens: maxTokens }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const d = await r.json();
    return (d && d.text) || '';
  } finally { clearTimeout(timer); }
}

const SYSTEM = [
  'You answer one question on a job application, as this candidate.',
  '',
  'HARD RULES:',
  '- Use ONLY facts in the candidate profile below. Never introduce an employer, tool,',
  '  certification, metric, or number of years that is not there.',
  '- If the profile does not support an answer, reply with exactly: INSUFFICIENT',
  '- Answer the question actually asked, concretely, in first person.',
  '- 2-5 sentences. No preamble, no sign-off, no markdown.',
  '- Never claim seniority, scale, or outcomes the profile does not state.',
  '',
  'Answering INSUFFICIENT is correct and expected when the profile is silent. A blank',
  'field is recoverable; a false claim on a job application is not.',
].join('\n');

// A question is "open-ended" when it wants prose. Yes/no and factual fields are
// answered deterministically elsewhere and must NOT come here — a model asked for a
// year count will drift it, and drift on years of experience is a false statement.
const OPEN_ENDED = /\?|^\s*(which|what|how|describe|tell us|why|explain|share|list|walk us through|elaborate)\b/i;
const FACTUAL = /^\s*(do|does|did|are|is|was|were|have|has|had|can|could|will|would|should|may|must|shall)\b|salary|compensation|notice period|start date|work authorization|sponsorship|visa|years of experience|how many years/i;

function isOpenEnded(label) {
  const l = (label || '').trim();
  if (!l || l.length < 8) return false;
  if (FACTUAL.test(l)) return false;
  return OPEN_ENDED.test(l);
}

// Everything the model may draw on, built from the persona so it cannot exceed it.
function profileOf(a) {
  return [
    `Name: ${a.fullName}`,
    a.currentTitle ? `Current role: ${a.currentTitle}` : '',
    a.totalYearsExperience ? `Years of experience: ${a.totalYearsExperience}` : '',
    a.primaryStack ? `Tools and stack: ${a.primaryStack}` : '',
    a.targetRoles ? `Target roles: ${[].concat(a.targetRoles).join(', ')}` : '',
    a.highestDegree ? `Education: ${a.highestDegree}${a.highestDegreeField ? ' in ' + a.highestDegreeField : ''}` : '',
    a.elevatorPitch ? `Profile: ${a.elevatorPitch}` : '',
    a.whyThisRoleBlurb ? `Motivation: ${a.whyThisRoleBlurb}` : '',
    a.keyAchievements ? `Achievements: ${[].concat(a.keyAchievements).join('; ')}` : '',
  ].filter(Boolean).join('\n');
}

const cache = new Map();
const norm = (q) => String(q || '').trim().toLowerCase().replace(/\s+/g, ' ');

let lastStats = { asked: 0, answered: 0, insufficient: 0, failed: 0 };

// Resolve one question. Null means "no honest answer available".
async function resolveOne(question, a, jobMeta) {
  const jd = (jobMeta && (jobMeta.description || jobMeta.jobDescription)) || '';
  const context = [
    `ROLE: ${(jobMeta && jobMeta.role) || 'unknown'} at ${(jobMeta && jobMeta.company) || 'unknown'}`,
    jd ? `POSTING:\n${String(jd).slice(0, 4000)}` : '',
    `CANDIDATE PROFILE:\n${profileOf(a)}`,
    `QUESTION: ${question}`,
  ].filter(Boolean).join('\n\n');

  const text = (await infer({ system: SYSTEM, prompt: context, model: 'haiku', maxTokens: 500 })).trim();
  if (!text || /^INSUFFICIENT\b/i.test(text)) return null;
  if (text.length < 20 || text.length > 2500) return null;
  return text;
}

// Called once per job, before any field is filled.
async function prepare(labels, a, jobMeta) {
  cache.clear();
  lastStats = { asked: 0, answered: 0, insufficient: 0, failed: 0 };

  const questions = [...new Set((labels || []).filter(isOpenEnded).map((l) => String(l).trim()))];
  if (!questions.length) return lastStats;

  // Sequential on purpose: a burst of parallel calls against one endpoint is how the
  // breaker trips mid-application and half the answers come back empty.
  for (const q of questions) {
    lastStats.asked++;
    try {
      const ans = await resolveOne(q, a, jobMeta);
      if (ans) { cache.set(norm(q), ans); lastStats.answered++; }
      else lastStats.insufficient++;
    } catch {
      lastStats.failed++;
    }
  }
  return lastStats;
}

// Sync lookup for the existing call sites. Null = leave the field alone.
function answerFor(question) {
  return cache.get(norm(question)) || null;
}

function stats() { return { ...lastStats }; }
function clear() { cache.clear(); }

module.exports = { prepare, answerFor, stats, clear, isOpenEnded, profileOf, SYSTEM };
