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
// IMPORTANT: your personal Chrome must be CLOSED first. A normal Chrome launch only
// stays in its own isolated profile if no other Chrome instance is running; otherwise
// Windows hands the tabs to your existing Chrome (the profile-picker you saw earlier).
// This script refuses to launch while Chrome is running, to prevent that.

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { personas } = require('./src/personas');

// Chrome path — edit if Chrome is installed elsewhere (or on macOS/Linux).
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

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

if (!fs.existsSync(CHROME)) {
  console.error(`Chrome not found at ${CHROME} — set CHROME_PATH env or edit this script.`);
  process.exit(1);
}

// Guard: refuse to launch while any Chrome is running (would absorb the tabs).
let chromeRunning = false;
try {
  const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', { encoding: 'utf8' });
  chromeRunning = /chrome\.exe/i.test(out);
} catch { /* tasklist failed (non-Windows?) — proceed anyway */ }

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

const args = [
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...LOGIN_PAGES,
];

const chrome = spawn(CHROME, args, { detached: true, stdio: 'ignore' });
chrome.on('error', (e) => { console.error('Failed to launch Chrome:', e.message); process.exit(1); });
chrome.unref();
setTimeout(() => process.exit(0), 2500);
