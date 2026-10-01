// Machine readiness checks — the composable set shared by `doctor` and `round start`.
//
// WHY THIS EXISTS
// Nothing verified that a machine could actually run this, so failures surfaced
// mid-run: a resume that resolves on the laptop and not on the server, a browser
// profile nobody has logged into, a missing xvfb-run on a box with no display. Each
// of those is cheap to detect up front and expensive to discover with a browser
// open and a queue half-consumed.
//
// SHAPE
// Every check returns the same record:
//
//   { name, ok, blocking, status, detail, remedy, data }
//
//   status   'pass' | 'fail' | 'warn' | 'skip'
//   blocking a failure here must stop a run (doctor exits non-zero, round start refuses)
//   remedy   what a human should DO about it — bootstrap.sh prints these verbatim
//
// A `warn` is a real finding that must not stop work: no secret-tool on Linux is the
// canonical example, since the file backend is a supported fallback.
//
// EVERYTHING IS SYNCHRONOUS
// `rounds.start()`, `src/cli.js` and `src/run-loop.js`'s top-level call are all
// synchronous. Making these checks async would force a ripple of awaits through
// callers that have no other reason to be async, so they use execFileSync — the
// same choice src/core/secret-store.js already makes.
//
// EVERY PROBE IS INJECTABLE
// `collect({ io })` takes its view of the world as data: platform, node version,
// which(), command output, free space, filesystem. That is what makes it possible
// to assert the verdict for the headless Ubuntu runner from the laptop, and it is
// how tests/doctor.test.js pins a headless runner's state as a fixture.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('./paths');
const config = require('./config');
const { personas: realPersonas } = require('../personas');
const { verifyResumeFile } = require('../resume/verify');
const disk = require('../util/disk');

const MIN_NODE_MAJOR = 20;

// ─── default probes ─────────────────────────────────────────────────────────

function defaultRun(cmd, args = []) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15000,
      windowsHide: true,
    });
    return { ok: true, stdout: (stdout || '').trim(), code: 0 };
  } catch (e) {
    return {
      ok: false,
      stdout: ((e.stdout || '') + '').trim(),
      stderr: ((e.stderr || '') + '').trim(),
      code: e.status === undefined ? null : e.status,
      error: e.code || e.message,
    };
  }
}

// Absolute path of a command on PATH, or null. `command -v` covers builtins and
// PATH entries on both macOS and Linux without depending on `which` being present.
function defaultWhich(cmd) {
  const r = defaultRun('/bin/sh', ['-c', `command -v ${cmd} 2>/dev/null`]);
  const out = (r.stdout || '').split('\n')[0].trim();
  return r.ok && out ? out : null;
}

function defaultIo(overrides = {}) {
  return {
    platform: process.platform,
    nodeVersion: process.versions.node,
    env: process.env,
    root: paths.root,
    run: defaultRun,
    which: defaultWhich,
    exists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
    readdir: (p) => { try { return fs.readdirSync(p); } catch { return null; } },
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    freeGb: (p) => disk.freeGb(p),
    verifyResume: verifyResumeFile,
    personas: realPersonas,
    // Injected so a test can describe a torn ledger without writing state.
    ledgerFiles: () => ({ applications: paths.applications(), outcomes: paths.outcomes() }),
    ...overrides,
  };
}

const mk = (name, blocking, status, detail, remedy = '', data = {}) => ({
  name,
  ok: status === 'pass' || status === 'skip' || status === 'warn',
  blocking,
  status,
  detail,
  remedy,
  data,
});

// ─── checks ─────────────────────────────────────────────────────────────────

function checkNode(io) {
  const v = io.nodeVersion || '0.0.0';
  const major = Number(String(v).split('.')[0]);
  if (!Number.isFinite(major)) {
    return mk('node', true, 'fail', `could not parse Node version "${v}"`, 'Install Node 20 or newer.', { version: v });
  }
  if (major < MIN_NODE_MAJOR) {
    return mk('node', true, 'fail', `Node ${v} is older than the required ${MIN_NODE_MAJOR}`,
      `Install Node >= ${MIN_NODE_MAJOR} (nvm install 22 && nvm use 22), then re-run npm ci.`, { version: v, major });
  }
  return mk('node', true, 'pass', `Node ${v}`, '', { version: v, major });
}

// Is the installed tree current with package-lock.json?
//
// Three distinct signals, deliberately weighted differently:
//   node_modules absent, or a locked dependency missing/at the wrong version
//     -> blocking. The runtime would behave differently from what is pinned.
//   package-lock.json newer than node_modules/.package-lock.json
//     -> warn only. A git checkout can touch mtimes without the content changing,
//        so treating it as fatal would refuse rounds for no reason.
function checkNpmCi(io) {
  const lockPath = path.join(io.root, 'package-lock.json');
  const pkgPath = path.join(io.root, 'package.json');
  const modulesLock = path.join(io.root, 'node_modules', '.package-lock.json');

  const lockRaw = io.readFile(lockPath);
  if (!lockRaw) {
    return mk('npm-ci', true, 'fail', 'package-lock.json is missing or unreadable',
      'Restore package-lock.json from git — npm ci cannot run without it.', {});
  }
  if (!io.exists(path.join(io.root, 'node_modules'))) {
    return mk('npm-ci', true, 'fail', 'node_modules is absent — dependencies were never installed',
      'Run: npm ci', {});
  }

  let lock; let pkg;
  try { lock = JSON.parse(lockRaw); } catch { lock = null; }
  try { pkg = JSON.parse(io.readFile(pkgPath) || '{}'); } catch { pkg = {}; }
  if (!lock) {
    return mk('npm-ci', true, 'fail', 'package-lock.json is not valid JSON',
      'Restore package-lock.json from git, then run npm ci.', {});
  }

  const declared = Object.keys({ ...(pkg.dependencies || {}) });
  const mismatches = [];
  for (const name of declared) {
    const locked = (lock.packages || {})[`node_modules/${name}`];
    const installedRaw = io.readFile(path.join(io.root, 'node_modules', name, 'package.json'));
    if (!installedRaw) { mismatches.push(`${name}: not installed`); continue; }
    let installed = null;
    try { installed = JSON.parse(installedRaw).version; } catch { /* unreadable */ }
    if (!installed) { mismatches.push(`${name}: installed version unreadable`); continue; }
    if (locked && locked.version && locked.version !== installed) {
      mismatches.push(`${name}: installed ${installed}, lock pins ${locked.version}`);
    }
  }
  if (mismatches.length) {
    return mk('npm-ci', true, 'fail', `installed tree disagrees with package-lock.json — ${mismatches.join('; ')}`,
      'Run: npm ci', { mismatches });
  }

  // Content matches; only mtimes may be stale.
  let stale = false;
  try {
    if (io.exists(modulesLock)) {
      stale = fs.statSync(lockPath).mtimeMs > fs.statSync(modulesLock).mtimeMs;
    }
  } catch { stale = false; }
  if (stale) {
    return mk('npm-ci', false, 'warn',
      'package-lock.json is newer than the installed tree, though every pinned version matches',
      'Probably a git checkout touching mtimes. Run npm ci if you have just changed dependencies.',
      { versionsMatch: true, mtimeStale: true });
  }
  return mk('npm-ci', true, 'pass', `${declared.length} pinned dependenc${declared.length === 1 ? 'y' : 'ies'} match package-lock.json`,
    '', { dependencies: declared });
}

function checkPlaywright(io) {
  const pkg = io.readFile(path.join(io.root, 'node_modules', 'playwright', 'package.json'));
  if (!pkg) {
    return mk('playwright', true, 'fail', 'the playwright package is not installed',
      'Run: npm ci', {});
  }
  let version = null;
  try { version = JSON.parse(pkg).version; } catch { /* unreadable */ }
  if (!version) {
    return mk('playwright', true, 'fail', 'playwright is installed but its package.json is unreadable',
      'Run: rm -rf node_modules && npm ci', {});
  }
  return mk('playwright', true, 'pass', `playwright ${version}`, '', { version });
}

// Where Playwright's `channel: 'chrome'` looks for a real Chrome, per platform.
const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  ],
  linux: [
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
};

// Real Chrome, resolvable through the 'chrome' channel — NOT bundled Chromium.
//
// This is load-bearing, not cosmetic. Greenhouse's invisible reCAPTCHA Enterprise
// and Lever's passive hCaptcha score the browser session: warm real Chrome passes
// silently where bundled Chromium gets a bot-flagged form. src/index.js hardcodes
// `channel: 'chrome'`, so if no real Chrome exists on the box, every run dies at
// launch — and the temptation is then to "fix" it with headless, which trades a
// visible failure for silently rejected applications.
//
// Resolution is by path probe plus `--version` rather than by launching a browser:
// doctor must be safe to run on the headless server without a display, and the
// version string is also how we prove this is Chrome and not Chromium.
function checkChrome(io) {
  const candidates = [
    ...(io.env.APPLY_AGENT_CHROME_PATH ? [io.env.APPLY_AGENT_CHROME_PATH] : []),
    ...(CHROME_CANDIDATES[io.platform] || []),
  ];
  const fromPath = io.platform === 'win32' ? null : (io.which('google-chrome') || io.which('google-chrome-stable'));
  if (fromPath) candidates.push(fromPath);

  const tried = [];
  let resolved = null;
  for (const c of candidates) {
    tried.push(c);
    if (io.exists(c)) { resolved = c; break; }
  }

  // The bundled browser, reported for contrast so "which Chrome is this?" is never
  // ambiguous in the output.
  let bundled = null;
  try {
    const { chromium } = require('playwright');
    bundled = chromium.executablePath();
  } catch { bundled = null; }

  if (!resolved) {
    return mk('chrome', true, 'fail', 'no real Google Chrome found for the \'chrome\' channel',
      io.platform === 'linux'
        ? 'Install Chrome: wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && sudo apt install -y ./google-chrome-stable_current_amd64.deb  (npx playwright install chrome also works). Never switch to headless bundled Chromium — the ATS anti-bot scoring rejects it.'
        : 'Install Google Chrome from https://google.com/chrome (or: npx playwright install chrome). Bundled Chromium is not a substitute — the ATS anti-bot scoring rejects it.',
      { tried, bundledChromium: bundled });
  }

  const v = io.run(resolved, ['--version']);
  const versionText = (v.stdout || '').trim();
  if (!v.ok || !versionText) {
    return mk('chrome', true, 'fail', `found ${resolved} but it would not report a version${v.error ? ` (${v.error})` : ''}`,
      'The binary is present but not executable by this user, or its libraries are missing. On Linux: sudo apt-get install -y -f, then re-run.',
      { path: resolved, bundledChromium: bundled });
  }
  // "Chromium 141.x" is the bundled build or a distro chromium; neither is what the
  // 'chrome' channel means.
  if (!/google chrome/i.test(versionText)) {
    return mk('chrome', true, 'fail', `${resolved} reports "${versionText}", which is not Google Chrome`,
      'Install real Google Chrome. Chromium scores differently against Greenhouse reCAPTCHA Enterprise and Lever hCaptcha.',
      { path: resolved, version: versionText, bundledChromium: bundled });
  }
  const isBundled = bundled && path.resolve(resolved) === path.resolve(bundled);
  if (isBundled) {
    return mk('chrome', true, 'fail', `the resolved path is Playwright's bundled browser (${resolved})`,
      'Install real Google Chrome outside the Playwright cache.',
      { path: resolved, version: versionText, bundledChromium: bundled });
  }
  return mk('chrome', true, 'pass', `${versionText} at ${resolved}`, '',
    { path: resolved, version: versionText, channel: 'chrome', bundledChromium: bundled });
}

// On a headless box every browser-touching command runs under `xvfb-run -a`. There
// IS a display; it is virtual. So the check is not "is there a DISPLAY" but "can one
// be arranged".
function checkXvfb(io) {
  if (io.platform !== 'linux') {
    return mk('xvfb', false, 'skip', `not Linux (${io.platform}) — Chrome has a real display here`, '', { platform: io.platform });
  }
  const xvfbRun = io.which('xvfb-run');
  const xvfb = io.which('Xvfb');
  const display = io.env.DISPLAY || '';

  if (!xvfbRun) {
    return display
      ? mk('xvfb', false, 'warn', `xvfb-run is not installed, but DISPLAY=${display} is set so Chrome has somewhere to draw`,
        'Install xvfb anyway (sudo apt-get install -y xvfb) — scheduled runs have no inherited DISPLAY.',
        { xvfbRun: null, xvfb, display })
      : mk('xvfb', true, 'fail', 'xvfb-run is not installed and DISPLAY is unset — Chrome cannot start headful',
        'Install it: sudo apt-get install -y xvfb. Then run browser commands as: xvfb-run -a npm run apply. Do NOT set headless:true instead.',
        { xvfbRun: null, xvfb, display: null });
  }
  if (!display) {
    // The correct and expected state for the scheduled runner.
    return mk('xvfb', true, 'pass', `xvfb-run at ${xvfbRun}, DISPLAY unset — wrap browser commands in \`xvfb-run -a\``,
      '', { xvfbRun, xvfb, display: null, wrapRequired: true });
  }
  return mk('xvfb', true, 'pass', `xvfb-run at ${xvfbRun}, DISPLAY=${display} already set`, '',
    { xvfbRun, xvfb, display, wrapRequired: false });
}

// secret-tool presence and the backend that actually results from it. Never
// blocking: the file backend is a supported fallback, owner-only 0600.
function checkSecretStore(io) {
  const secretTool = io.platform === 'linux' ? io.which('secret-tool') : null;
  // Ask secret-store itself rather than reimplementing its precedence, passing the
  // host being inspected so the answer is about that machine.
  let backend = null;
  try {
    backend = require('./secret-store').backend({
      platform: io.platform, env: io.env, hasSecretTool: !!secretTool,
    });
  } catch { backend = null; }

  const forced = io.env.APPLY_AGENT_SECRET_BACKEND || null;
  const data = { platform: io.platform, secretTool, backend, forcedByEnv: forced };

  if (io.platform === 'linux' && !secretTool) {
    return mk('secret-store', false, 'warn',
      `secret-tool is absent, so secret-store falls back to the ${backend || 'file'} backend (owner-only 0600 at ${paths.profile()})`,
      'Fine as-is on a headless server — libsecret needs a session keyring that a systemd timer has no access to. For OS-backed storage instead: sudo apt-get install -y libsecret-tools.',
      data);
  }
  return mk('secret-store', false, 'pass',
    `secret-store backend: ${backend}${secretTool ? ` (secret-tool at ${secretTool})` : ''}`, '', data);
}

// aws CLI + a real read AND write against the configured bucket prefix, but only
// when APPLY_AGENT_STATE_S3 is set. Read-only access is a silent trap: pulls work,
// the nightly push fails, and the two machines drift apart.
//
// The write probe puts one small object and deletes it. That is the only way to
// know the credentials can write; a policy can allow ListBucket and deny PutObject.
function checkS3(io) {
  const target = (io.env.APPLY_AGENT_STATE_S3 || '').trim();
  if (!target) {
    return mk('s3', false, 'skip', 'APPLY_AGENT_STATE_S3 is unset — no S3 sync configured', '', { configured: false });
  }
  const profile = (io.env.APPLY_AGENT_STATE_S3_PROFILE || io.env.AWS_PROFILE || '').trim();
  const profileArgs = profile ? ['--profile', profile] : [];
  const data = { configured: true, target, profile: profile || null };

  const awsBin = io.which('aws');
  if (!awsBin) {
    return mk('s3', true, 'fail', `APPLY_AGENT_STATE_S3 is set to ${target} but the aws CLI is not installed`,
      'Install it: sudo apt-get install -y awscli (or the official installer), then `aws configure`.', data);
  }
  data.awsPath = awsBin;

  const base = target.replace(/\/+$/, '');
  const ls = io.run('aws', ['s3', 'ls', base + '/', ...profileArgs]);
  if (!ls.ok) {
    return mk('s3', true, 'fail', `cannot read ${base}/ — ${(ls.stderr || ls.error || 'aws s3 ls failed').slice(0, 200)}`,
      `Check credentials for profile ${profile || '(default)'} and that the bucket prefix exists: aws s3 ls ${base}/`, data);
  }
  data.readable = true;

  // Probe key is namespaced and removed immediately. Nothing else is touched.
  const key = `${base}/.doctor-write-probe-${process.pid}-${Date.now()}`;
  const tmp = path.join(require('os').tmpdir(), `apply-agent-s3-probe-${process.pid}`);
  let wrote = false;
  try {
    fs.writeFileSync(tmp, 'apply-agent doctor write probe\n');
    const put = io.run('aws', ['s3', 'cp', tmp, key, ...profileArgs]);
    if (!put.ok) {
      return mk('s3', true, 'fail', `can read ${base}/ but cannot write to it — ${(put.stderr || put.error || 'aws s3 cp failed').slice(0, 200)}`,
        `Grant s3:PutObject on ${base}/* to profile ${profile || '(default)'}. Read-only access lets pulls succeed while every push fails, which silently drifts the two machines apart.`, data);
    }
    wrote = true;
    data.writable = true;
  } catch (e) {
    return mk('s3', true, 'fail', `write probe could not be prepared: ${e.message}`, 'Check that the temp directory is writable.', data);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    if (wrote) {
      const rm = io.run('aws', ['s3', 'rm', key, ...profileArgs]);
      data.probeCleanedUp = rm.ok;
    }
  }
  return mk('s3', true, 'pass', `${base}/ is readable and writable${profile ? ` with profile ${profile}` : ''}`, '', data);
}

// The two orchestrator endpoints: reachable, authenticating, answering in time.
//
// Reported, never blocking. That is the point of them: the runner holds no model
// account and no mail credentials, and when the orchestrator is down a run must
// degrade — base resumes instead of tailored, an attention item instead of a
// verification code — not refuse to start. Blocking here would convert a quality
// reduction into a cancelled night.
//
// What doctor buys is knowing WHICH it will be before the run starts, rather than
// discovering it forty jobs in.
//
// Synchronous elsewhere in this module, but these are network calls, so collect()
// takes an optional pre-resolved set (see collectAsync).
function endpointChecks(io, probes) {
  const out = [];
  for (const kind of ['tailor', 'emailCode']) {
    const name = kind === 'tailor' ? 'APPLY_AGENT_TAILOR_ENDPOINT' : 'APPLY_AGENT_EMAIL_CODE_ENDPOINT';
    const label = kind === 'tailor' ? 'endpoint:tailor' : 'endpoint:email-code';
    const p = probes ? probes[kind] : null;

    if (!p) {
      out.push(mk(label, false, 'skip', `${name} not probed`, '', { probed: false }));
      continue;
    }
    if (!p.configured) {
      out.push(mk(label, false, 'skip',
        kind === 'tailor'
          ? `${name} unset — tailoring will use the local claude CLI, or fall back to base resumes`
          : `${name} unset — email codes come from the browser only; a Gmail DOM change means an attention item per job`,
        '', { configured: false }));
      continue;
    }
    if (p.ok) {
      out.push(mk(label, false, 'pass', p.detail, '', p));
      continue;
    }
    // Configured but not working: a warning, with the consequence spelled out, because
    // the operator pointed at this endpoint deliberately and it is not doing its job.
    const consequence = kind === 'tailor'
      ? 'Runs will apply with BASE resumes and record friction.'
      : 'A job needing an emailed code will be skipped with an attention item.';
    const remedy = p.authenticated === false
      ? `The endpoint rejected APPLY_AGENT_SERVICE_TOKEN (HTTP ${p.status}). Check the token matches the orchestrator's. ${consequence}`
      : `Check the orchestrator is up and reachable on the private network: ${p.url}. ${consequence}`;
    out.push(mk(label, false, 'warn', `${name}: ${p.detail}`, remedy, p));
  }
  return out;
}

// Per persona: the base resume, and the browser profile.
//
// Two checks, not one, because the failures are different in kind and so are their
// remedies. A bad resume is a REPO problem: it travels via git and a fix on the
// laptop fixes every machine. An empty browser profile is a THIS MACHINE problem
// that copying cannot fix — profiles carry OS and device fingerprint, and one minted
// on macOS and replayed on Ubuntu is exactly the mismatch CAPTCHA scoring looks for.
// Each machine logs in once, locally, and keeps its own. That is also why round start
// checks resumes for every persona but profiles only for the persona it is running.
// A persona still holding template placeholders (`<Your_Resume.pdf>`, `<you@example.com>`)
// has not been set up, so it is not a failure to report as one: the template ships
// three example personas and most people use one. It is reported as a warning — fill
// it in or delete it — and it never blocks a round for a persona that IS set up.
const PLACEHOLDER = /<[^>]+>/;
const unconfigured = (p) => PLACEHOLDER.test(String(p.resumePath || '')) || PLACEHOLDER.test(String(p.email || ''));

// `active` is the persona a round is about to run as: it must be set up, whatever the
// others are. With no active persona (plain doctor), at least one must be set up.
function checkResumes(io, only, active) {
  const out = [];
  const entries = Object.entries(io.personas);
  const runAs = active || only;
  if (runAs && io.personas[runAs] && unconfigured(io.personas[runAs])) {
    out.push(mk(`persona:${runAs}`, true, 'fail',
      `persona "${runAs}" is not set up — src/personas.js still has template placeholders for it`,
      'Fill in its name, email, phone, resumePath and answers in src/personas.js (or say `setup` in Claude Code). Never run a placeholder persona.',
      { persona: runAs, reason: 'unconfigured' }));
  } else if (!runAs && entries.length && entries.every(([, p]) => unconfigured(p))) {
    out.push(mk('persona:any', true, 'fail', 'no persona is set up yet — src/personas.js is still the template',
      'Fill in at least one persona in src/personas.js (or say `setup` in Claude Code), then delete the examples you do not need.',
      { reason: 'unconfigured' }));
  }
  for (const [key, p] of entries) {
    if (only && key !== only) continue;
    if (unconfigured(p)) {
      out.push(mk(`resume:${key}`, false, 'warn',
        `persona "${key}" is not set up yet (it still has template placeholders)`,
        `Fill it in in src/personas.js, or delete it if you don't need it — routing walks whatever personas remain.`,
        { persona: key, path: p.resumePath, reason: 'unconfigured' }));
      continue;
    }
    const v = io.verifyResume(p.resumePath);
    out.push(v.ok
      ? mk(`resume:${key}`, true, 'pass', `${path.basename(p.resumePath)} is a valid PDF (${v.bytes} bytes)`, '',
        { persona: key, path: p.resumePath, bytes: v.bytes })
      : mk(`resume:${key}`, true, 'fail', `${v.detail}`,
        v.reason === 'caseMismatch'
          ? 'Rename to the exact case on disk. This resolves on macOS and fails on Linux, so it would otherwise surface only on the server: ls Resume/ and match it character for character.'
          : `Put a readable, non-empty PDF at ${p.resumePath} (git pull, or re-export it).`,
        { persona: key, path: p.resumePath, reason: v.reason }));
  }
  return out;
}

// One check per PROFILE DIRECTORY, not per persona — cloud and fullstack share one,
// so checking per persona would report the same directory twice and imply there are
// more browser accounts than there are.
function checkProfiles(io, only) {
  const out = [];
  const seenDirs = new Map();      // dir -> the persona key already reported for it
  for (const [key, p] of Object.entries(io.personas)) {
    if (only && key !== only) continue;
    if (unconfigured(p)) continue;   // reported once, by checkResumes
    const dir = p.browserProfile;
    if (seenDirs.has(dir)) continue;
    seenDirs.set(dir, key);
    const listing = io.exists(dir) ? io.readdir(dir) : null;
    const loginRemedy = io.platform === 'linux'
      ? `Nobody has logged in as ${key} on this machine yet. Log in ONCE, locally, over x11vnc: bash scripts/login-profile.sh ${key} (it prints the ssh tunnel and VNC steps), sign in to Google/LinkedIn, close Chrome. Never copy a profile from another machine — the fingerprint mismatch is what CAPTCHA scoring looks for.`
      : `Nobody has logged in as ${key} on this machine yet. Log in ONCE: node setup-browser-login.js ${key}, sign in to Google/LinkedIn, close Chrome. Never copy a profile between machines.`;

    if (listing === null) {
      out.push(mk(`profile:${key}`, true, 'fail', `browser profile directory is absent: ${dir}`, loginRemedy,
        { persona: key, path: dir, exists: false, entries: 0 }));
    } else if (listing.length === 0) {
      out.push(mk(`profile:${key}`, true, 'fail', `browser profile directory is EMPTY: ${dir}`, loginRemedy,
        { persona: key, path: dir, exists: true, entries: 0 }));
    } else {
      out.push(mk(`profile:${key}`, true, 'pass', `browser profile populated (${listing.length} entries)`, '',
        { persona: key, path: dir, exists: true, entries: listing.length }));
    }
  }
  return out;
}

// Profiles grouped by IDENTITY, plus the split-profile check.
//
// The invariant: personas sharing an email share one browser account, so they must
// resolve to one profile directory. Two directories for one account means signing the
// same Google account in twice, and two live sessions for one identity can invalidate
// each other — the profile silently logs out and the next run meets a CAPTCHA. That
// is exactly the state this repo was in with browser-profile-cloud and
// browser-profile-fullstack, and it is invisible without being told.
//
// Reported, not blocking: it is a persona-config mistake rather than a machine
// problem, and grounding both machines over it would be a worse failure than the one
// it describes. It surfaces loudly in doctor, where a human is reading.
function checkProfileIdentities(io) {
  const groups = new Map();        // email -> { email, personas[], dirs:Set, identity }
  for (const [key, p] of Object.entries(io.personas)) {
    const email = (p.email || '').toLowerCase() || `(no-email:${key})`;
    if (!groups.has(email)) groups.set(email, { email, identity: p.identity || '', personas: [], dirs: new Set() });
    const g = groups.get(email);
    g.personas.push(key);
    g.dirs.add(p.browserProfile || '');
  }

  const identities = [...groups.values()].map((g) => ({
    identity: g.identity,
    email: g.email,
    personas: g.personas,
    profileDirs: [...g.dirs],
    profileKeys: [...new Set(g.personas.map((k) => io.personas[k].profileKey || k))],
  }));
  const split = identities.filter((g) => g.personas.length > 1 && g.profileDirs.length > 1);

  const summary = identities
    .map((g) => `${g.personas.join('+')} -> ${g.profileDirs.map((d) => path.basename(d)).join(', ')}`)
    .join('; ');

  if (split.length) {
    return mk('profile-identities', false, 'warn',
      `one identity is split across multiple profile directories — ${split.map((g) => `${g.email}: ${g.personas.join('+')} -> ${g.profileDirs.map((d) => path.basename(d)).join(' + ')}`).join('; ')}`,
      `Personas sharing an email share a browser account and must share one profile directory: set the same profileKey on ${split.map((g) => g.personas.join(' and ')).join('; ')} in src/personas.js. Two directories for one account signs it in twice, and the two live sessions can invalidate each other.`,
      { identities, split });
  }
  return mk('profile-identities', false, 'pass',
    `${identities.length} identit${identities.length === 1 ? 'y' : 'ies'}, one profile each — ${summary}`,
    '', { identities, split: [] });
}

// Code version versus state version, and whether they match.
//
// Non-blocking here on purpose: `round start` enforces the gate itself (and refuses on
// state-newer), so doctor's job is to REPORT the mismatch with the fix, not to duplicate
// a refusal. A doctor that exits non-zero because the repo is a commit behind would be
// telling you something `git pull` already implies.
function checkSchema(io) {
  let st;
  try { st = require('./schema').status(); } catch (e) {
    return mk('schema', false, 'warn', `could not read the schema stamp: ${e.message}`, 'Check .state/schema.json is readable.', {});
  }
  const data = {
    codeVersion: st.codeVersion,
    stateVersion: st.stateVersion,
    match: st.match,
    relation: st.relation,
    updatedBy: st.updatedBy || null,
  };
  if (st.relation === 'state-newer') {
    return mk('schema', false, 'warn',
      `code v${st.codeVersion} is OLDER than state v${st.stateVersion} — runs will refuse`,
      'Another machine wrote state from a newer commit. Run: git pull && npm ci. Older code writing newer state drops fields silently, so this is enforced at `round start`.',
      data);
  }
  if (st.relation === 'state-older') {
    return mk('schema', false, 'pass',
      `code v${st.codeVersion}, state v${st.stateVersion} — will migrate forward on the next round start`,
      '', data);
  }
  return mk('schema', false, 'pass',
    st.relation === 'unstamped'
      ? `code v${st.codeVersion}, state unstamped — it will be stamped on the next round start`
      : `code v${st.codeVersion}, state v${st.stateVersion} — match`,
    '', data);
}

// Profile directories: how many, and how many are orphans.
//
// The 23-directory, 5.1 GB history in .gitignore/.profile-archive is the reason this is
// reported at all. Non-blocking: an orphaned profile wastes disk, it does not stop a
// run — and the disk check blocks when the waste actually matters.
function checkProfileDirs(io) {
  let state;
  try { state = require('./profiles').list(); } catch (e) {
    return mk('profiles', false, 'warn', `could not scan profile directories: ${e.message}`, '', {});
  }
  const t = state.totals;
  const detail = `${t.knownCount} live profile(s), ${t.liveMb} MB`
    + (t.unknownCount ? `; ${t.unknownCount} ORPHAN(S) matching no profileKey` : '')
    + (t.archivedCount ? `; ${t.archivedCount} quarantined, ${t.archivedMb} MB` : '');

  if (t.unknownCount) {
    return mk('profiles', false, 'warn', detail,
      `Orphans: ${state.unknown.map((p) => `${p.name} (${p.mb} MB)`).join(', ')}. `
      + 'Review with `apply-agent profiles list`, then `apply-agent profiles prune --apply` to quarantine them into .profile-archive/ (reversible), or add --delete to remove.',
      { ...t, unknown: state.unknown.map((p) => ({ name: p.name, mb: p.mb, lastUsed: p.lastUsed })) });
  }
  if (t.archivedMb > 1024) {
    return mk('profiles', false, 'warn', detail,
      `.profile-archive/ holds ${t.archivedMb} MB. Quarantine is reversible but not free — delete it once you are satisfied nothing there is needed.`,
      t);
  }
  return mk('profiles', false, 'pass', detail, '', t);
}

function checkDisk(io) {
  const floor = Number(config().diskFreeFloorGb);
  const free = io.freeGb(io.root);
  if (free === null) {
    return mk('disk', false, 'warn', 'could not determine free space', 'Check the mount manually: df -h .', { floorGb: floor });
  }
  const freeGb = disk.round1(free);
  if (free < floor) {
    return mk('disk', true, 'fail', `${freeGb} GB free is below the ${floor} GB floor`,
      `Free space before running. Reclaim the cheap things first: rm -rf .playwright-mcp/, then prune old run logs under ${paths.stateDir()}/runs/. Raise the floor with APPLY_AGENT_DISK_FREE_FLOOR_GB if it is genuinely too high.`,
      { freeGb, floorGb: floor });
  }
  return mk('disk', true, 'pass', `${freeGb} GB free (floor ${floor} GB)`, '', { freeGb, floorGb: floor });
}

// The ledger is what stops the same job being applied to twice, so an unreadable
// one is not a reporting problem — it means dedup is silently degraded.
//
// readAll() skips unparseable lines on purpose, tolerating a torn final line from a
// crash mid-append. That tolerance hides corruption from every other caller, so this
// check counts the damage instead: a bad line anywhere but the end is blocking.
function checkLedger(io) {
  const files = io.ledgerFiles();
  const data = {};
  const problems = [];

  for (const [label, file] of Object.entries(files)) {
    if (!io.exists(file)) { data[label] = { present: false, rows: 0 }; continue; }
    const raw = io.readFile(file);
    if (raw === null) {
      problems.push(`${label}: unreadable at ${file}`);
      data[label] = { present: true, readable: false };
      continue;
    }
    const lines = raw.split('\n');
    let rows = 0;
    const badLines = [];
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      try { JSON.parse(s); rows++; } catch { badLines.push(i + 1); }
    }
    // A single bad line at the very end is a torn append, which append-only storage
    // is designed to survive.
    const tornTail = badLines.length === 1 && badLines[0] >= lines.length - 1;
    data[label] = { present: true, readable: true, rows, badLines, tornTail };
    if (badLines.length && !tornTail) {
      problems.push(`${label}: ${badLines.length} unparseable line(s) at ${badLines.slice(0, 5).join(', ')}`);
    } else if (tornTail) {
      problems.push(`${label}: torn final line (tolerated)`);
    }
  }

  const hard = problems.filter((p) => !/tolerated/.test(p));
  if (hard.length) {
    return mk('ledger', true, 'fail', hard.join('; '),
      'Dedup reads this file — a hole in it can mean re-applying to a job already submitted. Inspect it before running: the rows are NDJSON, one JSON object per line, append-only.', data);
  }
  const rows = Object.values(data).reduce((n, d) => n + (d.rows || 0), 0);
  return mk('ledger', true, problems.length ? 'warn' : 'pass',
    problems.length ? `readable; ${problems.join('; ')}` : `readable (${rows} row(s) across ${Object.keys(files).length} file(s))`,
    '', data);
}

// ─── composition ────────────────────────────────────────────────────────────

// Run every check.
//   persona         narrows both resume and profile checks (doctor --persona)
//   profilePersona  narrows only the profile checks (round start)
function collect(opts = {}) {
  const io = defaultIo(opts.io || {});
  const resumeOnly = opts.persona || null;
  const profileOnly = opts.profilePersona || opts.persona || null;
  const checks = [
    checkNode(io),
    checkNpmCi(io),
    checkPlaywright(io),
    checkChrome(io),
    checkXvfb(io),
    checkSecretStore(io),
    checkS3(io),
    ...checkResumes(io, resumeOnly, opts.profilePersona || opts.persona || null),
    ...checkProfiles(io, profileOnly),
    checkProfileIdentities(io),
    ...endpointChecks(io, opts.probes),
    checkSchema(io),
    checkProfileDirs(io),
    checkDisk(io),
    checkLedger(io),
  ];
  const blocking = checks.filter((c) => c.blocking && !c.ok);
  return {
    ok: blocking.length === 0,
    host: {
      platform: io.platform,
      node: io.nodeVersion,
      display: io.env.DISPLAY || null,
      root: io.root,
      stateDir: paths.stateDir(),
      checkedAt: new Date().toISOString(),
    },
    summary: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      skip: checks.filter((c) => c.status === 'skip').length,
      fail: checks.filter((c) => c.status === 'fail').length,
      blocking: blocking.length,
    },
    blocking: blocking.map((c) => ({ name: c.name, detail: c.detail, remedy: c.remedy })),
    checks,
  };
}

// collect() with the two endpoints actually probed.
//
// Separate from collect() because collect() is synchronous and every other caller
// depends on that — rounds.start(), src/cli.js and run-loop.js are all sync paths, and
// making them async would ripple awaits through code with no other reason to be
// asynchronous. `round start` therefore does NOT probe: the endpoints are non-blocking
// by design, so a network round-trip on the critical path would buy nothing and add a
// failure mode. The run reports which backend it actually used when the tailoring pass
// runs; doctor is the tool for knowing beforehand.
async function collectAsync(opts = {}) {
  const orchestrator = require('../util/orchestrator');
  const [tailor, emailCode] = await Promise.all([
    orchestrator.probe('tailor').catch((e) => ({ kind: 'tailor', configured: true, ok: false, detail: e.message })),
    orchestrator.probe('emailCode').catch((e) => ({ kind: 'emailCode', configured: true, ok: false, detail: e.message })),
  ]);
  return collect({ ...opts, probes: { tailor, emailCode } });
}

// The subset `round start` enforces: every blocking check, nothing else. A round
// that cannot possibly succeed should not consume a queue slot or a round id.
function assertReady(opts = {}) {
  const report = collect(opts);
  if (!report.ok) {
    const err = new Error('preflight failed — ' + report.blocking.map((b) => `${b.name}: ${b.detail}`).join('; '));
    err.name = 'PreflightError';
    err.failures = report.blocking;
    err.report = report;
    throw err;
  }
  return report;
}

const GLYPH = { pass: 'ok  ', fail: 'FAIL', warn: 'warn', skip: '--  ' };

// Human rendering. Lives here rather than in bootstrap.sh so the remedy for a
// failure is written once, in one language.
function format(report) {
  const lines = [];
  lines.push(`apply-agent doctor — ${report.host.platform}, Node ${report.host.node}`);
  lines.push(`repo ${report.host.root}`);
  lines.push('');
  for (const c of report.checks) {
    lines.push(`  [${GLYPH[c.status] || c.status}] ${c.name}: ${c.detail}`);
    if (c.remedy && c.status !== 'pass') {
      for (const w of wrap(`-> ${c.remedy}`, 78)) lines.push(`        ${w}`);
    }
  }
  lines.push('');
  const s = report.summary;
  lines.push(`  ${s.pass} pass, ${s.warn} warn, ${s.skip} skipped, ${s.fail} fail`);
  lines.push(report.ok
    ? '  READY — nothing blocking.'
    : `  NOT READY — ${s.blocking} blocking failure(s) above must be fixed before a run.`);
  return lines.join('\n');
}

// Wrap on whitespace only. Long tokens (paths, commands) are left intact and
// allowed to overflow — a wrapped path is a path nobody can copy and paste.
function wrap(text, width) {
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/)) {
    if (line && (line + ' ' + w).length > width) { out.push(line); line = w; } else { line = line ? line + ' ' + w : w; }
  }
  if (line) out.push(line);
  return out;
}

module.exports = {
  collect,
  collectAsync,
  assertReady,
  format,
  endpointChecks,
  MIN_NODE_MAJOR,
  // Exported for focused testing and reuse.
  checkNode, checkNpmCi, checkPlaywright, checkChrome, checkXvfb, CHROME_CANDIDATES,
  checkSecretStore, checkS3, checkResumes, checkProfiles, checkProfileIdentities,
  checkSchema, checkProfileDirs, checkDisk, checkLedger,
  defaultIo,
};
