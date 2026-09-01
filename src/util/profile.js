// Chrome profile health — repair a persona's profile in place instead of
// abandoning it for a new directory.
//
// WHY THIS EXISTS
// run-loop.js used to react to a dead batch by walking to a fresh directory:
//
//   if (gained === 0) { profileSeq += 1; profile = BASE_PROFILE + profileSeq; }
//
// That kept the loop alive, but nothing ever deleted the abandoned dirs, so the
// repo accumulated 23 profiles and 5 GB. Worse, the name was built by string
// concatenation, so a run started with BATCH_PROFILE=browser-profile-qarun5
// produced browser-profile-qarun51/52/53 — which read like profiles 51-53.
//
// A batch that applies 0 jobs almost always means Chrome left a stale lock or a
// corrupt session/cache behind, not that the whole profile is unusable. Those
// artifacts are regenerated from scratch on the next launch, so deleting just
// them fixes the failure without costing anything.
//
// The login is what must survive. Cookies, Login Data, Preferences and the
// Local/Session Storage that hold the Google/LinkedIn/BuiltIn sessions from
// setup-browser-login.js are never touched by repairProfile — re-signing in is
// manual and MFA-gated, so it is the one thing worth protecting.

const fs = require('fs');
const path = require('path');

// Single-file locks Chrome leaves at the profile root when it is killed. These
// are the usual reason a relaunch refuses to attach to the profile.
const ROOT_LOCKS = [
  'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile',
  'DevToolsActivePort', 'CrashpadMetrics-active.pma', 'BrowserMetrics-spare.pma',
];

// Regenerable caches and session snapshots, relative to a profile-data dir.
// Sessions/ and Session Storage/ are what make a killed Chrome reopen into a
// broken "restore tabs?" state; the *Cache dirs are pure disk.
const DISPOSABLE = [
  'Sessions', 'Session Storage', 'GPUCache', 'Cache', 'Code Cache',
  'Service Worker', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GrShaderCache', 'ShaderCache', 'GraphiteDawnCache', 'optimization_guide_hint_cache_store',
  'blob_storage', 'Crashpad',
];

// Never removed — these carry the signed-in session.
const PROTECTED = [
  'Cookies', 'Cookies-journal', 'Login Data', 'Login Data-journal',
  'Preferences', 'Secure Preferences', 'Local Storage', 'IndexedDB',
  'Web Data', 'Local State',
];

const rm = (p) => {
  try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; }
};

// Profile-data directories inside a persistent context: the root itself plus
// every "Default"/"Profile N" it contains.
function dataDirs(profileDir) {
  const out = [profileDir];
  let entries = [];
  try { entries = fs.readdirSync(profileDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory() && /^(Default|Profile \d+)$/.test(e.name)) out.push(path.join(profileDir, e.name));
  }
  return out;
}

// Clear locks + regenerable caches, keep the login. Returns what it removed.
// Safe to call on a missing directory (a fresh profile needs no repair).
function repairProfile(profileDir) {
  const removed = [];
  if (!fs.existsSync(profileDir)) return { repaired: false, removed, reason: 'no such profile' };

  for (const name of ROOT_LOCKS) {
    const p = path.join(profileDir, name);
    if (fs.existsSync(p) && rm(p)) removed.push(name);
  }
  for (const dir of dataDirs(profileDir)) {
    for (const name of DISPOSABLE) {
      if (PROTECTED.includes(name)) continue; // belt and braces
      const p = path.join(dir, name);
      if (fs.existsSync(p) && rm(p)) removed.push(path.relative(profileDir, p) || name);
    }
  }
  return { repaired: removed.length > 0, removed };
}

// Full wipe — loses the signed-in session, so it is never automatic. Only for an
// explicit "this profile is beyond repair" reset.
function resetProfile(profileDir) {
  rm(profileDir);
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* caller will see the launch fail */ }
  return { reset: true };
}

// Bytes on disk, for reporting.
function profileSize(profileDir) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      let kids = [];
      try { kids = fs.readdirSync(p); } catch { return; }
      for (const k of kids) walk(path.join(p, k));
    } else { total += st.size; }
  };
  walk(profileDir);
  return total;
}

module.exports = { repairProfile, resetProfile, profileSize, ROOT_LOCKS, DISPOSABLE, PROTECTED };
