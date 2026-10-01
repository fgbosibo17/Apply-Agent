// The model backend for tailoring — pluggable, and never load-bearing.
//
// NO SDK, NO API KEY. src/refine-helper.js already established the pattern for this
// repo: shell out to the `claude` CLI in print mode, which uses the operator's
// existing Claude Code subscription auth. .env.example says plainly that there is no
// API key to set. Adding an SDK and a key here would mean two different auth stories
// in one codebase and a secret to keep out of git.
//
// Three backends, tried in order:
//
//   1. endpoint  APPLY_AGENT_TAILOR_ENDPOINT — POST {base, jobDescription} -> {tailored}
//                Bearer APPLY_AGENT_SERVICE_TOKEN. This is how the headless runner
//                borrows another host's model access: a headless box has no interactive
//                `claude` login, and a systemd timer has no session keyring to get
//                one, so the orchestrator does the model work.
//   2. claude    the CLI, exactly as refine-helper.js calls it.
//   3. none      no backend reachable.
//
// Endpoint first when configured: if the operator went to the trouble of pointing at
// one, that is the deliberate choice, and on the scheduled runner it is the only one
// that works.
//
// A missing backend is NOT an error. Tailoring is an enhancement; a run that cannot
// tailor applies with base resumes and keeps going. The caller records friction and
// moves on — never fail a run because a model was unavailable.
const { execFile } = require('child_process');
const os = require('os');

const orchestrator = require('../util/orchestrator');

// Read at call time, not at module load. Capturing these when the module is first
// required makes the backend unconfigurable by anything that requires it early — and
// untestable, since a test setting CLAUDE_BIN would be ignored.
const claudeBin = () => process.env.CLAUDE_BIN || 'claude';
const model = () => process.env.APPLY_AGENT_TAILOR_MODEL || process.env.REFINE_MODEL || 'sonnet';
// Tailoring a resume is a bigger job than refining one answer, so a longer ceiling
// than refine-helper's 120s — but still bounded. A batch pass over 40 jobs cannot sit
// on a hung request.
const timeoutMs = () => Number(process.env.APPLY_AGENT_TAILOR_TIMEOUT_MS || 180000);

const endpointUrl = () => orchestrator.tailorEndpoint();
const serviceToken = () => orchestrator.serviceToken();

// ── the prompt ─────────────────────────────────────────────────────────────
//
// Reorder, re-emphasise, reword what is ALREADY in the base resume. Not a moral
// position — a resume claiming an employer or a degree the candidate does not have
// fails at the first interview question and can cost an offer after it is signed.
// The same instruction refine-helper.js gives for single answers.
function buildPrompt({ base, jobDescription, persona }) {
  return [
    'You are tailoring a candidate\'s resume for one specific job posting.',
    '',
    'Rules:',
    '- Work ONLY from the base resume below. Do not add an employer, job title, date,',
    '  degree, certification, metric or skill that does not already appear in it.',
    '- You MAY reorder sections and bullets, re-emphasise what matches the posting,',
    '  drop material that is irrelevant to it, and reword for the posting\'s vocabulary',
    '  (e.g. if the base says "Playwright" and the posting says "end-to-end testing",',
    '  connect them explicitly).',
    '- Keep every date, employer name and job title exactly as the base states them.',
    '- Keep it to the same length as the base, or shorter. One to two pages.',
    '- Output GitHub-flavoured Markdown only. Start with the candidate\'s name as an',
    '  H1. No preamble, no explanation, no code fences around the whole document.',
    '',
    persona ? `Target role family: ${persona}` : '',
    '',
    '=== BASE RESUME ===',
    base,
    '',
    '=== JOB POSTING ===',
    (jobDescription || '').slice(0, 12000),
  ].filter((l) => l !== '').join('\n');
}

// ── claude CLI ─────────────────────────────────────────────────────────────

// cwd is a neutral temp dir so the CLI does not load this repo's large CLAUDE.md as
// project context on every call — the same reason refine-helper.js does it.
function claudePrint(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      ['-p', prompt, '--model', model()],
      { cwd: os.tmpdir(), timeout: timeoutMs(), maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        if (err) {
          const msg = (stderr || err.message || '').toString();
          if (err.code === 'ENOENT') return reject(new Error(`claude CLI not found ("${claudeBin()}")`));
          if (/authenticate|401|oauth|expired|login/i.test(msg)) {
            return reject(new Error('claude CLI needs login — run `claude` once in a terminal'));
          }
          if (out) return resolve(out);   // some builds print then exit non-zero
          return reject(new Error('claude CLI error: ' + msg.slice(0, 200)));
        }
        if (!out) return reject(new Error('claude returned an empty document'));
        resolve(out);
      }
    );
  });
}

function claudeAvailable() {
  return new Promise((resolve) => {
    execFile(claudeBin(), ['--version'], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? { found: false } : { found: true, version: (stdout || '').trim() });
    });
  });
}

// ── HTTP endpoint ──────────────────────────────────────────────────────────

// The transport lives in src/util/orchestrator.js — the same client, timeout policy
// and cooldown breaker the email-code fallback uses. Two endpoints authenticated by
// one token should not have two implementations of "call it and give up sensibly".
async function endpointTailor({ base, jobDescription }) {
  const res = await orchestrator.tailor({ base, jobDescription });
  if (!res.ok) throw new Error(res.error || 'tailor endpoint failed');
  return res.tailored;
}

// ── selection ──────────────────────────────────────────────────────────────

// Which backend would be used, without calling a model. Cached per process: a batch
// pass asks once, not once per job.
let probed = null;
async function detect({ force = false } = {}) {
  if (probed && !force) return probed;
  if (endpointUrl()) {
    probed = {
      kind: 'endpoint',
      available: true,
      detail: `POST ${endpointUrl()}${serviceToken() ? ' (bearer token set)' : ' (NO service token set)'}`,
    };
    return probed;
  }
  const cli = await claudeAvailable();
  probed = cli.found
    ? { kind: 'claude', available: true, detail: `claude CLI ${cli.version || ''}`.trim() + `, model ${model()}` }
    : {
      kind: 'none',
      available: false,
      detail: `no claude CLI ("${claudeBin()}") and no APPLY_AGENT_TAILOR_ENDPOINT`,
    };
  return probed;
}
const reset = () => { probed = null; };

// Produce a tailored markdown document, or throw. Callers treat a throw as "skip this
// one, record friction, use the base resume".
async function tailorOne({ base, jobDescription, persona }) {
  const backend = await detect();
  if (!backend.available) throw new Error(backend.detail);
  const prompt = buildPrompt({ base, jobDescription, persona });
  const text = backend.kind === 'endpoint'
    ? await endpointTailor({ base, jobDescription: jobDescription || '' })
    : await claudePrint(prompt);
  return { text: stripFences(text), backend: backend.kind };
}

// Models sometimes wrap the whole document in a fence despite being told not to.
// Cheaper to unwrap than to re-prompt.
function stripFences(text) {
  const t = (text || '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return (m ? m[1] : t).trim();
}

module.exports = {
  detect,
  reset,
  tailorOne,
  buildPrompt,
  stripFences,
  claudeAvailable,
  endpointUrl,
  model,
  claudeBin,
};
