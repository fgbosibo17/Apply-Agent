const fs = require('fs');
const os = require('os');
const path = require('path');

// Every test runs against its own throwaway state dir. paths.stateDir() reads
// the env var lazily, so setting it before the first call is enough.
function useTempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-agent-test-'));
  process.env.APPLY_AGENT_STATE_DIR = dir;
  return dir;
}

function resetState() {
  const dir = process.env.APPLY_AGENT_STATE_DIR;
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// A machine described as data, for src/core/preflight.js.
//
// This is how the headless Ubuntu runner's readiness gets asserted from the laptop:
// every probe preflight makes (platform, node version, which(), command output, free
// space, directory listings) is injectable, so a machine that is not in front of you
// can be a fixture. `machineRunner()` below is the real current state of the runner.
//
// Paths not named in `virtualPaths` fall through to the real filesystem on purpose:
// the npm-ci and playwright checks then run against this repo's actual node_modules
// rather than a fake of it, so they stay honest.
const REPO_ROOT = path.resolve(__dirname, '..');

// A described machine has its dependencies installed. Stated here rather than read off the
// developer's node_modules, because CI never runs `npm ci`: letting the npm-ci and
// playwright checks fall through to the real tree passed locally and failed 29 tests on a
// pristine clone. Seeded BEFORE the caller's overrides so an explicit entry still wins,
// but a test that supplies its own virtualPaths cannot silently drop it.
const PW_VERSION = '1.58.1';
const DEP_FILES = {
  [path.join(REPO_ROOT, 'package.json')]: JSON.stringify({ dependencies: { playwright: `^${PW_VERSION}` } }),
  [path.join(REPO_ROOT, 'package-lock.json')]: JSON.stringify({ packages: { 'node_modules/playwright': { version: PW_VERSION } } }),
  [path.join(REPO_ROOT, 'node_modules', 'playwright', 'package.json')]: JSON.stringify({ name: 'playwright', version: PW_VERSION }),
};

// Every path a preflight check probes that could otherwise be answered by the REAL
// machine. Each one is a place where "this fixture describes a Linux runner" quietly
// became "...plus whatever is installed on the box running the test".
//
// The Chrome candidates are the ones that bit hardest: the GitHub ubuntu image ships
// Chrome at /opt/google/chrome/chrome, which is FIRST in the candidate list, so
// checkChrome resolved it, found no `--version` fixture for it, and reported a blocking
// failure. Locally that path does not exist and everything passed.
const SEEDED_PATHS = {
  [path.join(REPO_ROOT, 'node_modules')]: true,
  '/opt/google/chrome/chrome': false,
  '/opt/google/chrome/google-chrome': false,
  '/usr/bin/google-chrome': false,
  '/usr/bin/google-chrome-stable': false,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': false,
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta': false,
};

function machineIo(over = {}) {
  const virtual = new Map(Object.entries({ ...SEEDED_PATHS, ...(over.virtualPaths || {}) }));
  const listings = new Map(Object.entries(over.listings || {}));
  const bins = { ...(over.bins || {}) };
  const versions = { ...(over.versions || {}) };
  delete over.virtualPaths; delete over.listings; delete over.bins; delete over.versions;

  return {
    platform: 'linux',
    nodeVersion: '22.23.2',
    env: {},
    root: REPO_ROOT,
    which: (cmd) => bins[cmd] || null,
    run: (cmd, args = []) => {
      const key = `${cmd} ${args.join(' ')}`.trim();
      if (versions[key] !== undefined) {
        const v = versions[key];
        return v === null ? { ok: false, stdout: '', stderr: 'boom', code: 1 } : { ok: true, stdout: v, code: 0 };
      }
      return { ok: false, stdout: '', stderr: `no fixture for: ${key}`, code: 127 };
    },
    exists: (p) => (virtual.has(p) ? virtual.get(p) : fs.existsSync(p)),
    readdir: (p) => (listings.has(p) ? listings.get(p) : null),
    readFile: (p) => (Object.prototype.hasOwnProperty.call(DEP_FILES, p)
      ? DEP_FILES[p]
      : (() => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } })()),
    freeGb: () => 432,
    verifyResume: () => ({ ok: true, reason: 'ok', detail: 'ok', bytes: 66820, caseExact: true }),
    personas: {},
    ledgerFiles: () => ({}),
    ...over,
  };
}

// The runner, as it actually is: headless Ubuntu, Node 22.23.2, real Chrome at
// /usr/bin/google-chrome working under xvfb-run, Xvfb and x11vnc present, no
// secret-tool, 432 GB free, all three resumes present and resolving.
//
// TWO profile directories for three personas, both populated: secondary has its own account,
// while primary and adjacent are one identity (one identity — same email, phone and
// LinkedIn) sharing browser-profile-primary. There is no browser-profile-adjacent, and
// there should not be: a third directory meant the same Google account signed in
// twice, and two live sessions for one identity can invalidate each other.
function machineRunner(over = {}) {
  const profile = (name) => path.join(REPO_ROOT, `browser-profile-${name}`);
  const personas = {
    secondary: {
      resumePath: path.join(REPO_ROOT, 'Resume', 'Alex_Doe_Secondary_Resume.pdf'),
      browserProfile: profile('secondary'), profileKey: 'secondary', email: 'alex.doe@example.com',
    },
    primary: {
      resumePath: path.join(REPO_ROOT, 'Resume', 'Jane_Doe_Primary_Resume.pdf'),
      browserProfile: profile('primary'), profileKey: 'primary', email: 'jane.doe@example.com',
    },
    adjacent: {
      resumePath: path.join(REPO_ROOT, 'Resume', 'Jane_Doe_Adjacent_Resume.pdf'),
      browserProfile: profile('primary'), profileKey: 'primary', email: 'jane.doe@example.com',
    },
  };
  return machineIo({
    platform: 'linux',
    nodeVersion: '22.23.2',
    env: {},                       // no DISPLAY: the scheduled runner has none
    personas,
    bins: {
      'xvfb-run': '/usr/bin/xvfb-run',
      Xvfb: '/usr/bin/Xvfb',
      x11vnc: '/usr/bin/x11vnc',
      'google-chrome': '/usr/bin/google-chrome',
      // deliberately absent: secret-tool, aws
    },
    versions: { '/usr/bin/google-chrome --version': 'Google Chrome 141.0.7390.54' },
    virtualPaths: {
      '/usr/bin/google-chrome': true,
      '/opt/google/chrome/chrome': false,
      '/opt/google/chrome/google-chrome': false,
      [profile('secondary')]: true,
      [profile('primary')]: true,
      [profile('adjacent')]: false,     // no such directory, by design
    },
    listings: {
      // A populated Chrome profile: the files that exist once someone has logged in.
      [profile('secondary')]: ['Default', 'Local State', 'SingletonLock', 'DevToolsActivePort'],
      [profile('primary')]: ['Default', 'Local State', 'SingletonLock'],
    },
    freeGb: () => 432,
    ...over,
  });
}

module.exports = { useTempState, resetState, machineIo, machineRunner, REPO_ROOT };
