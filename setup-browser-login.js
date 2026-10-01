// Browser login setup — opens NORMAL Chrome (not automation-driven) pointed at an
// isolated profile folder per identity. Because Chrome runs as an ordinary app,
// Google sign-in works AND "Sign in with Google" on the job boards works. Playwright
// later reuses the saved session — Google never re-challenges an existing valid login.
//
//   node setup-browser-login.js <persona>    (persona keys come from personas.js)
//   e.g.  node setup-browser-login.js primary
//
// You only NEED this if you want to use logged-in job boards (LinkedIn/Indeed/etc.)
// for discovery, or "Sign in with Google" on an ATS. Applications themselves
// (Greenhouse/Lever/Ashby/Workable) don't require login.
//
// Works on Windows, macOS and Linux with a screen. On a headless Linux SERVER use
// `bash scripts/login-profile.sh <persona>` instead — it logs in over VNC.
//
// IMPORTANT (Windows): your personal Chrome must be CLOSED first. A normal Chrome
// launch only stays in its own isolated profile if no other Chrome instance is
// running; otherwise Windows hands the tabs to your existing Chrome. This script
// refuses to launch on Windows while Chrome is running, to prevent that.

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { personas } = require('./src/personas');

// Real Chrome for this platform — the same places doctor and Playwright's 'chrome'
// channel look. CHROME_PATH (or APPLY_AGENT_CHROME_PATH) overrides.
const { CHROME_CANDIDATES } = require('./src/core/preflight');
function findChrome() {
  const override = process.env.CHROME_PATH || process.env.APPLY_AGENT_CHROME_PATH;
  if (override) return override;
  const candidates = [...(CHROME_CANDIDATES[process.platform] || [])];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  }
  if (process.platform === 'linux') {
    for (const bin of ['google-chrome', 'google-chrome-stable']) {
      try { candidates.push(execSync(`command -v ${bin}`, { encoding: 'utf8', shell: '/bin/sh' }).trim()); } catch { /* not on PATH */ }
    }
  }
  return candidates.find((c) => c && fs.existsSync(c)) || candidates[0] || 'google-chrome';
}
const CHROME = findChrome();

// Profiles are derived from personas.js — one isolated browser profile per persona.
const PROFILES = {};
for (const [key, p] of Object.entries(personas)) {
  PROFILES[key] = { dir: path.basename(p.browserProfile), label: key, email: p.email };
}

// Google first (so OAuth is primed), then common job-board login pages.
const LOGIN_PAGES = [
  'https://accounts.google.com/',
  'https://www.linkedin.com/login',
  'https://builtin.com/auth/login',
  'https://wellfound.com/login',
  'https://www.workatastartup.com/applicants/login',
  'https://www.welcometothejungle.com/en/signin',
  'https://www.dice.com/dashboard/login',
  'https://www.ziprecruiter.com/login',
  'https://secure.indeed.com/auth', // same account also covers SimplyHired
];

const who = (process.argv[2] || '').toLowerCase();
const profile = PROFILES[who];
if (!profile) {
  console.error('Usage: node setup-browser-login.js <persona>');
  console.error('  Available personas: ' + Object.keys(PROFILES).join(', '));
  process.exit(1);
}

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  console.error('\n  No screen here (DISPLAY is unset) — this looks like a headless server.');
  console.error(`  Log in over VNC instead:  bash scripts/login-profile.sh ${who}\n`);
  process.exit(1);
}

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — install Google Chrome, or set CHROME_PATH to its executable.`);
  process.exit(1);
}

// Guard (Windows): refuse to launch while any Chrome is running (would absorb the
// tabs). On macOS and Linux, launching the binary with its own --user-data-dir
// starts a separate instance, so a running Chrome is not a problem there.
let chromeRunning = false;
if (process.platform === 'win32') {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
    chromeRunning = /chrome\.exe/i.test(out);
  } catch { /* tasklist failed — proceed anyway */ }
}

if (chromeRunning) {
  console.error('\n  ⛔ Chrome is currently running.');
  console.error('  Close ALL Chrome windows first (your personal Chrome too), then re-run.');
  console.error('  Otherwise the login tabs open in your personal Chrome instead of the');
  console.error('  isolated profile — that is the profile-picker you saw earlier.\n');
  process.exit(2);
}

const userDataDir = path.resolve(__dirname, profile.dir);
fs.mkdirSync(userDataDir, { recursive: true });

console.log(`\n  Persona : ${profile.label}`);
console.log(`  Folder  : ${userDataDir}`);
console.log(`  Sign in as: ${profile.email}\n`);
console.log('  Opening a NORMAL isolated Chrome with all login tabs...');
console.log('  → Tab 1 is Google — sign in there first.');
console.log('  → Then each job board: use "Sign in with Google" OR email/password.');
console.log('  → CLOSE the window when every tab is logged in. Session saves automatically.\n');

// --password-store=basic and --use-mock-keychain are what Playwright passes when the
// runner launches this profile. Chrome picks its cookie-encryption key from those
// flags (macOS Keychain / Linux keyring otherwise), so a login made WITHOUT them is a
// session the runner cannot decrypt — it would look logged out. Windows ignores both.
const args = [
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
  '--use-mock-keychain',
  ...LOGIN_PAGES,
];

const chrome = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
chrome.on('error', (e) => { console.error('Failed to launch Chrome:', e.message); process.exit(1); });
chrome.unref();
setTimeout(() => process.exit(0), 2500);
