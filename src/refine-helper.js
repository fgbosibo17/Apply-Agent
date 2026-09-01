// Refine helper — a tiny local server the Chrome extension talks to.
//
// It does the two things a browser extension can't do on its own:
//   1. /refine  — rewrite ONE answer per the user's plain-English instruction by
//                 shelling out to the `claude` CLI in print mode (`claude -p`).
//                 This uses YOUR existing Claude Code / Anthropic subscription auth
//                 — there is NO API key anywhere. If `claude` needs a login, just
//                 run `claude` once in a terminal to re-authenticate.
//   2. /log, /seen — read/write the SAME applications-log.csv / seen-jobs.csv
//                 ledger the Playwright bot uses, so a hand-application through the
//                 extension is deduped against the bot (and vice-versa).
//
// Start with:  npm run refine-helper
//
// Env (all optional):
//   REFINE_PORT   default 8730 — if you change it, update HELPER in extension/background.js
//   REFINE_MODEL  default "haiku" (any name/alias the claude CLI accepts: haiku|sonnet|opus|<full-id>)
//   CLAUDE_BIN    default "claude" — path to the CLI if it's not on PATH

const http = require('http');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const { personas } = require('./personas');
const { appendApplication, appendSeen, loadSeenUrls } = require('./log');

const PORT = Number(process.env.REFINE_PORT) || 8730;
const MODEL = process.env.REFINE_MODEL || 'haiku';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

const normUrl = (u) => (u || '').trim().split('?')[0].split('#')[0];

// ── CORS + body helpers ──────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

// ── Claude CLI rewrite (uses your subscription, no key) ──────────────────────
function profileBlock(p) {
  return [
    p.fullName && `Name: ${p.fullName}`,
    p.currentTitle && `Current title: ${p.currentTitle}`,
    p.currentEmployer && `Current employer: ${p.currentEmployer}`,
    p.totalYearsExperience && `Years of experience: ${p.totalYearsExperience}`,
    p.elevatorPitch && `Elevator pitch: ${p.elevatorPitch}`,
    p.whyThisRoleBlurb && `Why this kind of role: ${p.whyThisRoleBlurb}`,
    Array.isArray(p.targetRoles) && p.targetRoles.length && `Target roles: ${p.targetRoles.slice(0, 8).join(', ')}`,
  ].filter(Boolean).join('\n');
}

// Run `claude -p <prompt> --model <model>` and return trimmed stdout.
// cwd is a neutral temp dir so the CLI doesn't load this repo's big CLAUDE.md
// as project context on every call (faster, cheaper, and keeps answers focused).
function claudePrint(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      CLAUDE_BIN,
      ['-p', prompt, '--model', MODEL],
      { cwd: os.tmpdir(), timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const out = (stdout || '').trim();
        if (err) {
          const msg = (stderr || err.message || '').toString();
          if (/authenticate|401|oauth|expired|login/i.test(msg)) {
            return reject(new Error('Claude CLI needs login — run `claude` once in a terminal to re-authenticate, then retry.'));
          }
          if (err.code === 'ENOENT') {
            return reject(new Error(`Claude CLI not found ("${CLAUDE_BIN}"). Install Claude Code or set CLAUDE_BIN to its path.`));
          }
          if (out) return resolve(out); // some builds print to stdout then exit non-zero
          return reject(new Error('claude CLI error: ' + msg.slice(0, 300)));
        }
        if (!out) return reject(new Error('Claude returned an empty answer.'));
        resolve(out);
      }
    );
  });
}

async function refine({ label, current, instruction, personaKey }) {
  const p = personas[personaKey];
  if (!p) throw new Error(`Unknown persona "${personaKey}" (expected qa | cloud | fullstack).`);
  if (!instruction || !instruction.trim()) throw new Error('No refine instruction given.');

  const prompt =
    "You are refining a SINGLE answer on a job-application form. Rewrite the current answer to follow the instruction.\n\n" +
    "Rules:\n" +
    "- Stay strictly truthful to the candidate profile below. Never invent employers, titles, degrees, dates, or facts not implied by that profile.\n" +
    "- Keep it appropriate for a job application: professional, concise, first person, no clichés.\n" +
    "- Match the length the instruction implies; if it doesn't mention length, keep close to the current answer's length.\n" +
    "- Output ONLY the rewritten answer text — no preamble, no surrounding quotes, no explanation.\n\n" +
    "Candidate profile:\n" + profileBlock(p) + "\n\n" +
    `Field / question: ${label || '(unlabeled)'}\n\n` +
    `Current answer:\n${current || '(empty)'}\n\n` +
    `Instruction: ${instruction.trim()}`;

  return claudePrint(prompt);
}

// Best-effort check that the CLI binary exists (not whether it's logged in — that
// only surfaces on an actual /refine call, reported with a clear re-auth message).
function cliAvailable() {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['--version'], { timeout: 8000 }, (err, stdout) => {
      resolve(err ? { found: false } : { found: true, version: (stdout || '').trim() });
    });
  });
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const cli = await cliAvailable();
      return json(res, 200, { ok: true, model: MODEL, cliFound: cli.found, cliVersion: cli.version || null, personas: Object.keys(personas) });
    }

    if (req.method === 'GET' && url.pathname === '/seen') {
      const u = normUrl(url.searchParams.get('u') || '');
      const applied = u ? loadSeenUrls().has(u) : false;
      return json(res, 200, { applied, url: u });
    }

    if (req.method === 'POST' && url.pathname === '/refine') {
      const body = await readBody(req);
      console.log(`[refine] ${body.personaKey} · "${(body.label || '').slice(0, 50)}" · "${(body.instruction || '').slice(0, 50)}"`);
      const answer = await refine(body);
      return json(res, 200, { answer });
    }

    if (req.method === 'POST' && url.pathname === '/log') {
      const b = await readBody(req);
      if (!b.url) return json(res, 400, { error: 'url required' });
      const cleanUrl = normUrl(b.url);
      appendSeen({
        company: b.company || '', role: b.role || '', url: cleanUrl,
        action: b.action || 'Applied', reason: b.reason || 'via Chrome extension (manual)',
      });
      if ((b.action || 'Applied') === 'Applied') {
        appendApplication({
          company: b.company || '', role: b.role || '', url: cleanUrl,
          atsPlatform: b.atsPlatform || '', discoverySource: b.discoverySource || 'Extension',
          status: 'Applied', matchScore: b.matchScore || '', notes: b.notes || 'Manual apply via Chrome extension',
          persona: b.persona || '',
        });
      }
      console.log(`[log] ${b.action || 'Applied'} · ${b.company || '?'} · ${cleanUrl}`);
      return json(res, 200, { ok: true, url: cleanUrl });
    }

    return json(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[error]', e.message);
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  const cli = await cliAvailable();
  console.log(`Refine helper listening on http://127.0.0.1:${PORT}`);
  console.log(`  model: ${MODEL} (via the claude CLI — your subscription, no API key)`);
  console.log(`  claude CLI: ${cli.found ? 'found ✓ ' + (cli.version || '') : `NOT FOUND ✗  (set CLAUDE_BIN or install Claude Code)`}`);
  console.log(`  personas: ${Object.keys(personas).join(', ')}`);
  console.log('Leave this running while you apply. Ctrl-C to stop.');
});
